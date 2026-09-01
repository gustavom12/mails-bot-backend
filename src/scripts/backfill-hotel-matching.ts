/**
 * Backfill de los campos de auto-asignación de hotel: `matchAliases` y
 * `matchDomains`.
 *
 * Cómo los deriva:
 *   · matchAliases — el nombre completo del hotel, más el nombre sin su palabra
 *     genérica inicial ("Hotel", "Casa", "Hostal", "Posada"…) cuando lo que
 *     queda tiene al menos 4 letras. "Hotel Parián" → ["Hotel Parián", "Parián"].
 *     Se descarta cualquier alias que quede ambiguo entre dos hoteles de la
 *     misma casilla (matchearía a los dos y la regla no asignaría nada).
 *   · matchDomains — NO se adivinan: se buscan en los mails ya recibidos los
 *     dominios de remitente cuya etiqueta principal coincide con el nombre del
 *     hotel (hoteldama.mx ↔ "Hotel Dama"). Solo se agrega lo que existe.
 *
 * Solo completa hoteles que tengan el campo vacío: no pisa lo que haya cargado
 * el staff a mano. Es idempotente.
 *
 * DRY-RUN por defecto. Con --apply escribe los cambios.
 *
 * Uso:
 *   npm run hotels:backfill-matching -- [--tenant <id>] [--apply]
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

const GENERIC_PREFIXES = ['hotel', 'casa', 'hostal', 'posada', 'hostel', 'the'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const normalize = (s: string): string =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

/** Solo letras y dígitos, para comparar "Hotel Parián" con "hotelparian.com". */
const letters = (s: string): string => normalize(s).replace(/[^a-z0-9]/g, '');

/** Nombre completo + nombre sin la palabra genérica inicial. */
function deriveAliases(name: string): string[] {
  const aliases = [name.trim()];
  const words = name.trim().split(/\s+/);
  if (words.length > 1 && GENERIC_PREFIXES.includes(normalize(words[0]))) {
    const rest = words.slice(1).join(' ');
    if (normalize(rest).replace(/[^a-z0-9]/g, '').length >= 4) aliases.push(rest);
  }
  return [...new Set(aliases)];
}

async function main() {
  const tenantFilter = arg('tenant');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No se pudo obtener la conexión a la base de datos');

  const query: Record<string, unknown> = { active: true };
  if (tenantFilter) query.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  const hotels = await db.collection('hotels').find(query).toArray();

  console.log(`\n📦 ${hotels.length} hotel(es) activos\n`);

  // Dominios de remitente vistos en los mails entrantes, por tenant.
  const senderDomainsByTenant = new Map<string, Set<string>>();
  const inbound = await db
    .collection('messages')
    .find({ direction: 'inbound' })
    .project({ tenantId: 1, 'from.address': 1 })
    .toArray();
  for (const m of inbound) {
    const domain = normalize(String(m.from?.address ?? '')).split('@')[1];
    if (!domain) continue;
    const key = String(m.tenantId);
    const set = senderDomainsByTenant.get(key) ?? new Set<string>();
    set.add(domain);
    senderDomainsByTenant.set(key, set);
  }

  // Aliases que matchearían a más de un hotel de la misma casilla: inservibles.
  const aliasUses = new Map<string, number>();
  for (const h of hotels) {
    const key = String(h.mailboxId);
    for (const a of deriveAliases(String(h.name))) {
      aliasUses.set(`${key}|${normalize(a)}`, (aliasUses.get(`${key}|${normalize(a)}`) ?? 0) + 1);
    }
  }

  let updated = 0;
  for (const hotel of hotels) {
    const hasAliases = (hotel.matchAliases ?? []).length > 0;
    const hasDomains = (hotel.matchDomains ?? []).length > 0;
    if (hasAliases && hasDomains) {
      console.log(`  ⏭  "${hotel.name}" ya configurado, se omite`);
      continue;
    }

    const aliases = deriveAliases(String(hotel.name)).filter((a) => {
      const ambiguous = (aliasUses.get(`${String(hotel.mailboxId)}|${normalize(a)}`) ?? 0) > 1;
      if (ambiguous)
        console.log(`  ⚠️  "${hotel.name}": alias "${a}" es ambiguo en la casilla, descartado`);
      return !ambiguous;
    });

    const target = letters(String(hotel.name));
    const domains = [...(senderDomainsByTenant.get(String(hotel.tenantId)) ?? [])].filter((d) => {
      const label = d.split('.').slice(0, -1).join('');
      return letters(label) === target;
    });

    const set: Record<string, string[]> = {};
    if (!hasAliases) set.matchAliases = aliases;
    if (!hasDomains) set.matchDomains = domains;

    console.log(`  ✏️  "${hotel.name}"`);
    if (!hasAliases) console.log(`        aliases: ${aliases.join(' | ') || '(ninguno)'}`);
    if (!hasDomains)
      console.log(
        `        dominios: ${domains.join(' | ') || '(ninguno encontrado en los mails)'}`,
      );

    if (apply) {
      await db.collection('hotels').updateOne({ _id: hotel._id }, { $set: set });
      updated++;
    }
  }

  console.log(
    apply
      ? `\n✅ ${updated} hotel(es) actualizados\n`
      : `\n🔍 DRY-RUN: no se modificó nada. Volvé a correr con --apply.\n`,
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
