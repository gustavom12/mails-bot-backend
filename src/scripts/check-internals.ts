/**
 * Diagnóstico del clasificador de mails internos.
 *
 * Corre el MISMO proceso de clasificación que usa el webhook (mismos prompts,
 * mismo modelo, mismo umbral de confianza) sobre conversaciones existentes,
 * filtradas por CLI, y muestra si cada una iría a "Internos" o al flujo normal.
 *
 * Por defecto es un DRY-RUN: no modifica nada. Con --apply mueve efectivamente
 * a "Internos" las conversaciones que pasen el umbral.
 *
 * Uso:
 *   npm run internals:check -- [filtros]
 *
 * Filtros (combinables):
 *   --tenant <id>        tenant a analizar (obligatorio si hay más de uno)
 *   --id <id>            una conversación puntual
 *   --mailbox <id>       por casilla
 *   --hotel <id|none>    por hotel ("none" = sin hotel asignado)
 *   --state <nombre>     por nombre de estado del kanban (ej: "Nuevo")
 *   --contact <texto>    contactEmail contiene el texto (case-insensitive)
 *   --subject <texto>    asunto contiene el texto (case-insensitive)
 *   --limit <n>          máximo de conversaciones a evaluar (default: 20)
 *   --apply              aplica los cambios (default: solo mostrar)
 *
 * Ejemplos:
 *   npm run internals:check -- --tenant 6a6bf9b2f89d1d90ed0a2aba --state Nuevo
 *   npm run internals:check -- --tenant 6a6bf9b2f89d1d90ed0a2aba --contact tripleseat --apply
 *
 * Variables de entorno: MONGODB_URI, OPENAI_API_KEY, OPENAI_MODEL,
 * INTERNAL_STATE_NAME (default "Internos"), INTERNAL_MIN_CONFIDENCE (default 0.95).
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';
import OpenAI from 'openai';
import {
  buildInternalCheckSystemPrompt,
  buildInternalCheckUserPrompt,
  InternalCheckResult,
} from '../ai/ai-triage.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const INTERNAL_STATE_NAME = process.env.INTERNAL_STATE_NAME ?? 'Internos';
const MIN_CONFIDENCE = Number(process.env.INTERNAL_MIN_CONFIDENCE ?? '0.95');

// ─── Parseo de argumentos ────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const limit = Number(args.limit ?? '20');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('✖ Falta OPENAI_API_KEY en el .env — el clasificador necesita la IA.');
    process.exit(1);
  }
  const openai = new OpenAI({ apiKey });

  console.log(`🔌 Conectando a ${MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}…`);
  const conn = await mongoose.createConnection(MONGODB_URI).asPromise();
  const db = conn.db;
  if (!db) throw new Error('No se pudo obtener el handle de la DB');

  const conversations = db.collection('conversations');
  const messages = db.collection('messages');
  const states = db.collection('conversation_states');

  // ── Resolver tenant ──
  let tenantId: mongoose.Types.ObjectId;
  if (typeof args.tenant === 'string') {
    tenantId = new mongoose.Types.ObjectId(args.tenant);
  } else {
    const tenants = await db.collection('tenants').find({}).toArray();
    if (tenants.length !== 1) {
      console.error(
        `✖ Hay ${tenants.length} tenants — indicá cuál con --tenant <id>:\n` +
          tenants.map((t) => `   ${t._id}  ${t.name ?? ''}`).join('\n'),
      );
      await conn.close();
      process.exit(1);
    }
    tenantId = tenants[0]._id as unknown as mongoose.Types.ObjectId;
  }

  // ── Estado "Internos" del tenant ──
  const internalState = await states.findOne({
    tenantId,
    name: INTERNAL_STATE_NAME,
    active: true,
  });
  if (!internalState) {
    console.error(
      `✖ El tenant no tiene un estado activo llamado "${INTERNAL_STATE_NAME}". ` +
        'Crealo primero (o ajustá INTERNAL_STATE_NAME).',
    );
    await conn.close();
    process.exit(1);
  }

  // ── Armar filtro de conversaciones ──
  const filter: Record<string, unknown> = { tenantId };
  if (typeof args.id === 'string') filter._id = new mongoose.Types.ObjectId(args.id);
  if (typeof args.mailbox === 'string') filter.mailboxId = new mongoose.Types.ObjectId(args.mailbox);
  if (typeof args.hotel === 'string') {
    filter.hotelId = args.hotel === 'none' ? null : new mongoose.Types.ObjectId(args.hotel);
  }
  if (typeof args.contact === 'string') {
    filter.contactEmail = { $regex: args.contact, $options: 'i' };
  }
  if (typeof args.subject === 'string') {
    filter.subject = { $regex: args.subject, $options: 'i' };
  }
  if (typeof args.state === 'string') {
    const state = await states.findOne({
      tenantId,
      name: { $regex: `^${args.state}$`, $options: 'i' },
    });
    if (!state) {
      console.error(`✖ No existe el estado "${args.state}" en este tenant.`);
      await conn.close();
      process.exit(1);
    }
    filter.stateId = state._id;
  }

  const targets = await conversations
    .find(filter)
    .sort({ lastActivityAt: -1 })
    .limit(limit)
    .toArray();

  console.log(
    `\n📦 ${targets.length} conversación(es) a evaluar — umbral de confianza: ${MIN_CONFIDENCE}` +
      ` — modo: ${apply ? '⚠️  APPLY (mueve a Internos)' : 'dry-run (solo muestra)'}\n`,
  );

  let toInternal = 0;
  let normalFlow = 0;
  let alreadyInternal = 0;
  let skipped = 0;

  for (const conv of targets) {
    const label = `[${(conv.subject ?? '(sin asunto)').slice(0, 55)}] <${conv.contactEmail ?? '?'}>`;

    if (conv.stateId?.toString() === internalState._id.toString()) {
      console.log(`⚪ ya está en Internos  ${label}`);
      alreadyInternal++;
      continue;
    }

    // Mismo input que producción: el último mensaje inbound de la conversación.
    const lastInbound = await messages
      .find({ conversationId: conv._id, direction: 'inbound' })
      .sort({ receivedAt: -1 })
      .limit(1)
      .toArray();

    if (lastInbound.length === 0) {
      console.log(`⚪ sin mensajes inbound  ${label}`);
      skipped++;
      continue;
    }
    const msg = lastInbound[0];

    let result: InternalCheckResult | null = null;
    try {
      const completion = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        temperature: 0.3,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildInternalCheckSystemPrompt() },
          {
            role: 'user',
            content: buildInternalCheckUserPrompt({
              fromName: msg.from?.name,
              fromAddress: msg.from?.address,
              subject: msg.subject,
              bodyPreview: msg.bodyPreview,
            }),
          },
        ],
      });
      const content = completion.choices[0]?.message?.content;
      result = content ? (JSON.parse(content) as InternalCheckResult) : null;
    } catch (err) {
      console.log(`✖ error de OpenAI  ${label}: ${(err as Error).message}`);
      skipped++;
      continue;
    }

    const passes =
      result?.internal === true &&
      typeof result.confidence === 'number' &&
      result.confidence >= MIN_CONFIDENCE;

    const detail =
      `internal=${result?.internal ?? '?'} confianza=${result?.confidence ?? '?'} ` +
      `categoría=${result?.category ?? '-'} — ${result?.reason ?? 'sin razón'}`;

    if (passes) {
      toInternal++;
      console.log(`🟣 → INTERNOS  ${label}\n      ${detail}`);
      if (apply) {
        await conversations.updateOne(
          { _id: conv._id },
          {
            $set: {
              stateId: internalState._id,
              unread: false,
              aiProcessedAt: new Date(),
              aiSummary: `Interno (${result!.category ?? 'automático'}): ${result!.reason ?? 'sin detalle'}`,
            },
            $push: {
              statusHistory: {
                stateId: internalState._id,
                stateName: internalState.name,
                changedBy: null,
                changedAt: new Date(),
                note: `auto: clasificado como interno por IA (${result!.category ?? 'automático'}, confianza ${Math.round(result!.confidence * 100)}%) [script]`,
              },
            } as never,
          },
        );
        console.log('      ✔ movida a Internos');
      }
    } else {
      normalFlow++;
      console.log(`🟢 flujo normal  ${label}\n      ${detail}`);
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(
    `Resultado — a Internos: ${toInternal}${apply ? ' (aplicado)' : ''}, ` +
      `flujo normal: ${normalFlow}, ya internas: ${alreadyInternal}, omitidas: ${skipped}`,
  );
  if (!apply && toInternal > 0) {
    console.log('Para aplicar los cambios, repetí el comando agregando --apply');
  }

  await conn.close();
}

run().catch((err) => {
  console.error('Error en check-internals:', err);
  process.exit(1);
});
