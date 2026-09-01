/**
 * Resincroniza el estado del kanban con lo que realmente pasó en la casilla.
 *
 * EL PROBLEMA
 * Cuando alguien responde desde la plataforma, `sendReply` mueve la conversación
 * a "Esperando respuesta cliente" y la marca leída. Cuando la misma respuesta se
 * manda directo desde Gmail/Outlook, el sync trae el mensaje saliente y actualiza
 * `lastActivityAt` y `lastMessageDirection`, pero NO toca el estado: la
 * conversación queda en "Nuevo" o "Respuesta preparada" aunque ya fue contestada.
 * El tablero muestra trabajo pendiente que en realidad ya está hecho.
 *
 * QUÉ HACE
 * Toma como verdad el último mensaje real de cada conversación (no el campo
 * `lastMessageDirection`, que también puede estar desfasado) y corrige:
 *   · el estado → "Esperando respuesta cliente" si el último mensaje es saliente
 *   · `lastMessageDirection`, `lastActivityAt` y `unread`, si quedaron viejos
 * Cada cambio de estado queda registrado en `statusHistory` con `changedBy: null`
 * (igual que el cron de seguimiento), así se distingue del cambio de una persona.
 *
 * QUÉ NO TOCA
 *   · Estados cerrados ("Cerrado", "Internos"): son decisiones terminales.
 *   · "Requiere atención": lo administra el cron de seguimiento, que volvería a
 *     ponerlo ahí en la corrida siguiente. Usá --include-attention para incluirlo.
 *   · Conversaciones cuyo último mensaje es entrante, salvo que pases
 *     --fix-inbound (ver abajo).
 *
 * --fix-inbound (opcional)
 * Corrige el desfase inverso: conversaciones en "Esperando respuesta cliente"
 * donde el cliente YA respondió y nadie lo vio. Pasa al estado inicial y se
 * marcan como no leídas para que vuelvan a la cola. Ocurre sobre todo en
 * conversaciones sin hotel asignado, donde el triage de IA corta antes de
 * reclasificar.
 *
 * DRY-RUN por defecto: muestra el impacto sin escribir nada.
 *
 * Uso:
 *   npm run conversations:resync-state -- [filtros] [--apply]
 *
 * Filtros y opciones:
 *   --tenant <id>          limitar a un tenant
 *   --mailbox <id>         limitar a una casilla
 *   --include-attention    incluir las que están en "Requiere atención"
 *   --fix-inbound          corregir además el desfase inverso (ver arriba)
 *   --limit <n>            máximo de conversaciones a mostrar en el detalle
 *   --apply                escribir los cambios
 *
 * Ejemplos:
 *   npm run conversations:resync-state -- --tenant 6a6bf9b2f89d1d90ed0a2aba
 *   npm run conversations:resync-state -- --tenant 6a6bf9b2f89d1d90ed0a2aba --apply
 *
 * Variables de entorno: MONGODB_URI, FOLLOWUP_STATE_NAME
 * (default "Esperando respuesta cliente"), ATTENTION_STATE_NAME
 * (default "Requiere atención").
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';
const WAITING_STATE_NAME = process.env.FOLLOWUP_STATE_NAME ?? 'Esperando respuesta cliente';
const ATTENTION_STATE_NAME = process.env.ATTENTION_STATE_NAME ?? 'Requiere atención';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface StateDoc {
  _id: mongoose.Types.ObjectId;
  tenantId: mongoose.Types.ObjectId;
  name: string;
  isDefault?: boolean;
  isClosed?: boolean;
}

/** Estados relevantes de un tenant, resueltos una sola vez. */
interface TenantStates {
  waiting?: StateDoc;
  attention?: StateDoc;
  initial?: StateDoc;
  closedIds: Set<string>;
  byId: Map<string, StateDoc>;
}

async function main() {
  const tenantFilter = arg('tenant');
  const mailboxFilter = arg('mailbox');
  const includeAttention = process.argv.includes('--include-attention');
  const fixInbound = process.argv.includes('--fix-inbound');
  const detailLimit = Number(arg('limit') ?? '30');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No se pudo obtener la conexión a la base de datos');

  // ── Estados por tenant ──────────────────────────────────────────────────
  const stateQuery: Record<string, unknown> = { active: true };
  if (tenantFilter) stateQuery.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  const allStates = (await db
    .collection('conversation_states')
    .find(stateQuery)
    .toArray()) as unknown as StateDoc[];

  const statesByTenant = new Map<string, TenantStates>();
  for (const s of allStates) {
    const tid = String(s.tenantId);
    const entry = statesByTenant.get(tid) ?? {
      closedIds: new Set<string>(),
      byId: new Map<string, StateDoc>(),
    };
    entry.byId.set(String(s._id), s);
    if (s.isClosed) entry.closedIds.add(String(s._id));
    if (s.name === WAITING_STATE_NAME) entry.waiting ??= s;
    if (s.name === ATTENTION_STATE_NAME) entry.attention ??= s;
    if (s.isDefault) entry.initial ??= s;
    statesByTenant.set(tid, entry);
  }

  // ── Conversaciones a evaluar ────────────────────────────────────────────
  const convQuery: Record<string, unknown> = {};
  if (tenantFilter) convQuery.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  if (mailboxFilter) convQuery.mailboxId = new mongoose.Types.ObjectId(mailboxFilter);
  const conversations = await db.collection('conversations').find(convQuery).toArray();

  // ── Último mensaje real de cada conversación ────────────────────────────
  // Es la fuente de verdad: `lastMessageDirection` puede estar tan desfasado
  // como el estado que estamos corrigiendo.
  const msgMatch: Record<string, unknown> = {};
  if (tenantFilter) msgMatch.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  const lastMessages = await db
    .collection('messages')
    .aggregate([
      { $match: msgMatch },
      { $sort: { receivedAt: 1 } },
      {
        $group: {
          _id: '$conversationId',
          direction: { $last: '$direction' },
          receivedAt: { $last: '$receivedAt' },
          subject: { $last: '$subject' },
        },
      },
    ])
    .toArray();

  const lastByConv = new Map<string, { direction: string; receivedAt: Date }>(
    lastMessages.map((m) => [
      String(m._id),
      { direction: String(m.direction), receivedAt: m.receivedAt as Date },
    ]),
  );

  // ── Evaluación ──────────────────────────────────────────────────────────
  let answeredOutside = 0;
  let clientReplied = 0;
  let fieldsOnly = 0;
  let alreadyOk = 0;
  let skippedClosed = 0;
  let skippedAttention = 0;
  let skippedNoMessages = 0;
  let skippedNoState = 0;

  const detail: string[] = [];
  const ops: { id: mongoose.Types.ObjectId; set: Record<string, unknown>; push?: unknown }[] = [];

  for (const conv of conversations) {
    const last = lastByConv.get(String(conv._id));
    if (!last) {
      skippedNoMessages++;
      continue;
    }

    const tenantStates = statesByTenant.get(String(conv.tenantId));
    if (!tenantStates) {
      skippedNoState++;
      continue;
    }

    const currentStateId = String(conv.stateId);
    const currentState = tenantStates.byId.get(currentStateId);

    // Campos que quedaron viejos, se corrigen en cualquier caso.
    const set: Record<string, unknown> = {};
    if (conv.lastMessageDirection !== last.direction) {
      set.lastMessageDirection = last.direction;
    }
    if (
      last.receivedAt &&
      (!conv.lastActivityAt || new Date(conv.lastActivityAt) < new Date(last.receivedAt))
    ) {
      set.lastActivityAt = last.receivedAt;
    }

    let push: unknown;
    let kind: 'outbound' | 'inbound' | null = null;

    if (tenantStates.closedIds.has(currentStateId)) {
      // "Cerrado" / "Internos": decisión terminal, no se reabre sola.
      skippedClosed++;
    } else if (last.direction === 'outbound') {
      const waiting = tenantStates.waiting;
      const isAttention =
        tenantStates.attention && currentStateId === String(tenantStates.attention._id);

      if (!waiting) {
        skippedNoState++;
      } else if (currentStateId === String(waiting._id)) {
        alreadyOk++;
      } else if (isAttention && !includeAttention) {
        // La administra el cron de seguimiento; moverla acá sería pelearse con él.
        skippedAttention++;
      } else {
        kind = 'outbound';
        set.stateId = waiting._id;
        set.unread = false;
        push = {
          statusHistory: {
            stateId: waiting._id,
            stateName: waiting.name,
            changedBy: null,
            changedAt: new Date(),
            note: 'auto: respondida fuera de la plataforma (resync)',
          },
        };
      }
    } else if (fixInbound && tenantStates.waiting && tenantStates.initial) {
      // Desfase inverso: figura esperando al cliente, pero el cliente ya respondió.
      if (currentStateId === String(tenantStates.waiting._id)) {
        kind = 'inbound';
        set.stateId = tenantStates.initial._id;
        set.unread = true;
        push = {
          statusHistory: {
            stateId: tenantStates.initial._id,
            stateName: tenantStates.initial.name,
            changedBy: null,
            changedAt: new Date(),
            note: 'auto: el cliente respondió y quedó sin procesar (resync)',
          },
        };
      }
    }

    if (Object.keys(set).length === 0) {
      if (kind === null && !tenantStates.closedIds.has(currentStateId)) alreadyOk++;
      continue;
    }

    if (kind === 'outbound') answeredOutside++;
    else if (kind === 'inbound') clientReplied++;
    else fieldsOnly++;

    if (detail.length < detailLimit) {
      const tag = kind === 'outbound' ? '📤' : kind === 'inbound' ? '📥' : '🔧';
      const move = set.stateId
        ? `${currentState?.name ?? '(?)'} → ${tenantStates.byId.get(String(set.stateId))?.name}`
        : `solo campos (${Object.keys(set).join(', ')})`;
      detail.push(`  ${tag} ${move.padEnd(46)} "${String(conv.subject ?? '').slice(0, 52)}"`);
    }

    ops.push({ id: conv._id as mongoose.Types.ObjectId, set, push });
  }

  // ── Reporte ─────────────────────────────────────────────────────────────
  console.log(`\n📦 ${conversations.length} conversación(es) evaluadas`);
  console.log(`   estado "respondida": "${WAITING_STATE_NAME}"`);
  console.log(
    `   estado del cron:     "${ATTENTION_STATE_NAME}"${includeAttention ? ' (incluido)' : ' (excluido)'}`,
  );
  console.log(
    `   desfase inverso:     ${fixInbound ? 'se corrige' : 'no se toca (--fix-inbound)'}\n`,
  );

  console.log(`─── A corregir ────────────────────────────────`);
  console.log(`  respondidas fuera de la plataforma → "${WAITING_STATE_NAME}": ${answeredOutside}`);
  if (fixInbound)
    console.log(`  el cliente respondió y quedó sin procesar:          ${clientReplied}`);
  console.log(`  solo campos desfasados (sin cambio de estado):      ${fieldsOnly}`);

  console.log(`\n─── Sin cambios ───────────────────────────────`);
  console.log(`  ya estaban bien:                 ${alreadyOk}`);
  console.log(`  en estado cerrado / Internos:    ${skippedClosed}`);
  console.log(
    `  en "${ATTENTION_STATE_NAME}":${' '.repeat(Math.max(1, 22 - ATTENTION_STATE_NAME.length))}${skippedAttention}`,
  );
  console.log(`  sin mensajes:                    ${skippedNoMessages}`);
  if (skippedNoState > 0) console.log(`  ⚠️  tenant sin los estados necesarios: ${skippedNoState}`);

  if (detail.length > 0) {
    console.log(`\n─── Detalle (primeras ${detail.length}) ──────────────────`);
    detail.forEach((d) => console.log(d));
  }

  if (!apply) {
    console.log(`\n🔍 DRY-RUN: no se modificó nada. Volvé a correr con --apply.\n`);
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const op of ops) {
    const update: Record<string, unknown> = { $set: op.set };
    if (op.push) update.$push = op.push;
    const res = await db.collection('conversations').updateOne({ _id: op.id }, update);
    written += res.modifiedCount;
  }
  console.log(`\n✅ ${written} conversación(es) actualizadas\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
