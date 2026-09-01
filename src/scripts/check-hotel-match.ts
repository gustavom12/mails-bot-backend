/**
 * Diagnóstico de la auto-asignación de hotel.
 *
 * Corre EXACTAMENTE las mismas reglas que el webhook (`matchHotelForMessage`)
 * sobre las conversaciones ya existentes y muestra cuáles se asignarían solas:
 *   1. dominio propio del hotel en el remitente  (matchDomains)
 *   2. nombre/alias único del hotel en el asunto (matchAliases)
 *
 * Antes de evaluar descarta las que ya irían a "Internos" por regla de
 * remitente (no-reply o INTERNAL_SENDER_DOMAINS): esas no necesitan hotel.
 *
 * DRY-RUN por defecto. Con --apply asigna el hotel a las conversaciones que
 * hoy están sin hotel y tienen match (no toca las que ya tienen uno).
 *
 * Uso:
 *   npm run hotels:check-match -- [--tenant <id>] [--limit <n>] [--verbose] [--apply]
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';
import {
  matchHotelForMessage,
  matchInternalSenderRule,
  parseInternalSenderDomains,
  HotelMatchCandidate,
} from '../ai/ai-triage.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';
const INTERNAL_DOMAINS = parseInternalSenderDomains(process.env.INTERNAL_SENDER_DOMAINS);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const tenantFilter = arg('tenant');
  const limit = Number(arg('limit') ?? '0');
  const verbose = process.argv.includes('--verbose');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No se pudo obtener la conexión a la base de datos');

  const convQuery: Record<string, unknown> = {};
  if (tenantFilter) convQuery.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  const conversations = await db
    .collection('conversations')
    .find(convQuery)
    .sort({ lastActivityAt: -1 })
    .limit(limit > 0 ? limit : 0)
    .toArray();

  const hotels = await db.collection('hotels').find({ active: true }).toArray();
  const hotelsByMailbox = new Map<string, HotelMatchCandidate[]>();
  for (const h of hotels) {
    const key = String(h.mailboxId);
    hotelsByMailbox.set(key, [
      ...(hotelsByMailbox.get(key) ?? []),
      {
        id: String(h._id),
        name: String(h.name),
        matchAliases: h.matchAliases ?? [],
        matchDomains: h.matchDomains ?? [],
      },
    ]);
  }

  // Primer mensaje inbound de cada conversación (el que ve la regla en vivo).
  const firstInbound = new Map<string, { subject?: string; from?: { address?: string } }>();
  const inbound = await db
    .collection('messages')
    .find({ direction: 'inbound' })
    .project({ conversationId: 1, subject: 1, 'from.address': 1, receivedAt: 1 })
    .sort({ receivedAt: 1 })
    .toArray();
  for (const m of inbound) {
    const key = String(m.conversationId);
    if (!firstInbound.has(key)) firstInbound.set(key, m as never);
  }

  let internal = 0;
  let alreadyAssigned = 0;
  let byDomain = 0;
  let bySubject = 0;
  let noSignal = 0;
  let noMessage = 0;
  let agree = 0;
  let disagree = 0;
  const samples: string[] = [];
  const toApply: { id: mongoose.Types.ObjectId; hotelId: string; reason: string }[] = [];

  console.log(`\n📦 ${conversations.length} conversación(es)`);
  console.log(`   dominios internos: ${INTERNAL_DOMAINS.join(', ') || '(ninguno)'}\n`);

  for (const conv of conversations) {
    const msg = firstInbound.get(String(conv._id));
    if (!msg) {
      noMessage++;
      continue;
    }

    const from = msg.from?.address ?? '';
    if (matchInternalSenderRule(from, INTERNAL_DOMAINS)) {
      internal++;
      continue;
    }

    const candidates = hotelsByMailbox.get(String(conv.mailboxId)) ?? [];
    const match = matchHotelForMessage({ fromAddress: from, subject: msg.subject }, candidates);

    if (conv.hotelId) {
      alreadyAssigned++;
      // Ground truth: comparar la regla contra lo que decidió una persona.
      if (match) {
        if (match.hotelId === String(conv.hotelId)) agree++;
        else {
          disagree++;
          const real = hotels.find((h) => String(h._id) === String(conv.hotelId));
          console.log(
            `  ❌ DISCREPA "${String(conv.subject ?? '').slice(0, 55)}"\n` +
              `       regla=${match.hotelName} (${match.rule})  humano=${real?.name}`,
          );
        }
      }
      continue;
    }

    if (!match) {
      noSignal++;
      continue;
    }
    if (match.rule === 'dominio') byDomain++;
    else bySubject++;

    if (samples.length < 25 || verbose) {
      samples.push(
        `    [${match.rule}] ${match.hotelName.padEnd(22)} "${String(conv.subject ?? '').slice(0, 58)}" de ${from}`,
      );
    }
    toApply.push({
      id: conv._id as mongoose.Types.ObjectId,
      hotelId: match.hotelId,
      reason: `auto (${match.rule}): ${match.detail}`,
    });
  }

  const auto = byDomain + bySubject;
  const needHotel = auto + noSignal;
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

  console.log(`─── Resultado ─────────────────────────────────`);
  console.log(`  ya van a "Internos" (no necesitan hotel): ${internal}`);
  console.log(`  ya tenían hotel asignado:                 ${alreadyAssigned}`);
  console.log(`  sin mensajes inbound:                     ${noMessage}`);
  console.log(`\n  De las ${needHotel} sin hotel que sí lo necesitan:`);
  console.log(`    por dominio del remitente: ${byDomain}  ${pct(byDomain, needHotel)}`);
  console.log(`    por nombre en el asunto:   ${bySubject}  ${pct(bySubject, needHotel)}`);
  console.log(`    sin señal → manual:        ${noSignal}  ${pct(noSignal, needHotel)}`);
  console.log(`    COBERTURA AUTOMÁTICA:      ${auto}  ${pct(auto, needHotel)}`);

  if (alreadyAssigned > 0) {
    console.log(`\n  Contraste con asignaciones humanas (ground truth):`);
    console.log(
      `    coincide: ${agree}   discrepa: ${disagree}   (sin match: ${alreadyAssigned - agree - disagree})`,
    );
  }

  console.log(`\n  Ejemplos de auto-asignación:`);
  samples.forEach((s) => console.log(s));

  if (apply) {
    let n = 0;
    for (const t of toApply) {
      const res = await db.collection('conversations').updateOne(
        { _id: t.id, hotelId: null },
        {
          $set: {
            hotelId: new mongoose.Types.ObjectId(t.hotelId),
            hotelAutoAssigned: true,
            hotelAssignmentReason: t.reason,
          },
        },
      );
      n += res.modifiedCount;
    }
    console.log(`\n✅ ${n} conversación(es) asignadas\n`);
  } else {
    console.log(`\n🔍 DRY-RUN: no se modificó nada. Volvé a correr con --apply.\n`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
