/**
 * Migración de casilla(s) conectada(s) entre dos bases de datos.
 *
 * Copia las casillas conectadas (con OAuth de Aurinko/Microsoft) desde una DB
 * origen hacia una DB destino, junto con su tenant y hotel referenciados, para
 * mantener la integridad referencial. Preserva los _id y timestamps originales.
 *
 * Uso:
 *   npm run migrate:mailbox
 *
 * Variables de entorno (opcionales, con defaults):
 *   MIGRATE_SOURCE_URI  → DB origen  (default: mongodb://localhost:27017/mails-bot)
 *   MIGRATE_DEST_URI    → DB destino (default: MONGODB_URI del .env)
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const SOURCE_URI =
  process.env.MIGRATE_SOURCE_URI ?? 'mongodb://localhost:27017/mails-bot';
const DEST_URI =
  process.env.MIGRATE_DEST_URI ??
  process.env.MONGODB_URI ??
  'mongodb+srv://mails-bot:fu7tMeidd5HWXivL@mails-bot.tbimvlx.mongodb.net/?appName=mails-bot';

// ─── Schemas (flexibles: strict:false para copiar todos los campos tal cual) ──

const flexible = { timestamps: true, strict: false } as const;

const TenantSchema = new mongoose.Schema({}, flexible);
const HotelSchema = new mongoose.Schema({}, flexible);
const MailboxSchema = new mongoose.Schema({}, flexible);

function models(conn: mongoose.Connection) {
  return {
    Tenant: conn.model('Tenant', TenantSchema, 'tenants'),
    Hotel: conn.model('Hotel', HotelSchema, 'hotels'),
    Mailbox: conn.model('Mailbox', MailboxSchema, 'mailboxes'),
  };
}

/** Upsert preservando el _id original. */
async function upsertById(model: mongoose.Model<any>, doc: any, label: string) {
  const plain = doc.toObject ? doc.toObject() : doc;
  const { _id, ...rest } = plain;
  await model.updateOne(
    { _id },
    { $set: rest },
    { upsert: true, timestamps: false },
  );
  console.log(`  ✅ ${label}: ${_id}`);
}

async function migrate() {
  console.log('🔌 Conectando…');
  console.log(`   origen : ${SOURCE_URI.replace(/\/\/[^@]*@/, '//***@')}`);
  console.log(`   destino: ${DEST_URI.replace(/\/\/[^@]*@/, '//***@')}\n`);

  const source = await mongoose.createConnection(SOURCE_URI).asPromise();
  const dest = await mongoose.createConnection(DEST_URI).asPromise();

  const src = models(source);
  const dst = models(dest);

  // Casillas conectadas: status connected, o con cuenta de Aurinko, o con token.
  const mailboxes = (await src.Mailbox.find({
    $or: [
      { status: 'connected' },
      { aurinkoAccountId: { $ne: null } },
      { accessToken: { $ne: null } },
    ],
  }).lean()) as any[];

  if (mailboxes.length === 0) {
    console.log('⚠️  No se encontraron casillas conectadas en la DB origen.');
    await source.close();
    await dest.close();
    return;
  }

  console.log(`📦 ${mailboxes.length} casilla(s) conectada(s) encontrada(s)\n`);

  const migratedTenants = new Set<string>();
  const migratedHotels = new Set<string>();

  for (const mailbox of mailboxes) {
    console.log(`📬 Casilla: ${mailbox.email}`);

    // 1. Tenant
    if (mailbox.tenantId && !migratedTenants.has(String(mailbox.tenantId))) {
      const tenant = await src.Tenant.findById(mailbox.tenantId).lean();
      if (tenant) {
        await upsertById(dst.Tenant, tenant, 'Tenant');
        migratedTenants.add(String(mailbox.tenantId));
      } else {
        console.log(`  ⚠️  Tenant ${mailbox.tenantId} no encontrado en origen`);
      }
    }

    // 2. Hotel — en el nuevo modelo la FK vive en Hotel.mailboxId
    if (mailbox.hotelId && !migratedHotels.has(String(mailbox.hotelId))) {
      const hotel = (await src.Hotel.findById(mailbox.hotelId).lean()) as any;
      if (hotel) {
        // Asegurar la relación N:1 en el destino: el hotel apunta a su casilla.
        hotel.mailboxId = mailbox._id;
        await upsertById(dst.Hotel, hotel, 'Hotel');
        migratedHotels.add(String(mailbox.hotelId));
      } else {
        console.log(`  ⚠️  Hotel ${mailbox.hotelId} no encontrado en origen`);
      }
    }

    // 3. Mailbox
    await upsertById(dst.Mailbox, mailbox, 'Casilla');
    console.log('');
  }

  console.log('─────────────────────────────────────────────');
  console.log('✅ Migración completada');

  await source.close();
  await dest.close();
}

migrate().catch((err) => {
  console.error('❌ Error en la migración:', err);
  process.exit(1);
});
