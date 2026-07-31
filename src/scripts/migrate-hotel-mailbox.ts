/**
 * Migración in-place: invierte la relación Mailbox ↔ Hotel.
 *
 * Modelo anterior: `Mailbox.hotelId` (único) → 1 casilla por hotel (1:1).
 * Modelo nuevo:     `Hotel.mailboxId`        → varios hoteles por casilla (N:1).
 *
 * Qué hace:
 *   1. Por cada casilla con `hotelId`, setea `hotel.mailboxId = mailbox._id`.
 *   2. Elimina el índice único viejo `hotelId_1` de la colección `mailboxes`.
 *   3. Limpia el campo `hotelId` de las casillas ($unset).
 *
 * Es idempotente: se puede correr varias veces sin efectos adversos.
 * Las conversaciones existentes conservan su `hotelId` (no se tocan).
 *
 * Uso:
 *   npm run migrate:hotel-mailbox
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

async function migrate() {
  console.log('🔌 Conectando…');
  console.log(`   ${MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}\n`);

  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;
  if (!db) throw new Error('No se pudo obtener la conexión a la base de datos');

  const mailboxes = db.collection('mailboxes');
  const hotels = db.collection('hotels');

  // 1. Poblar hotel.mailboxId desde mailbox.hotelId
  console.log('─── Poblando Hotel.mailboxId ──────────────────');
  const withHotel = await mailboxes.find({ hotelId: { $ne: null } }).toArray();
  console.log(`📦 ${withHotel.length} casilla(s) con hotelId encontradas`);

  let updated = 0;
  for (const mailbox of withHotel) {
    const res = await hotels.updateOne(
      { _id: mailbox.hotelId },
      { $set: { mailboxId: mailbox._id } },
    );
    if (res.matchedCount > 0) {
      updated++;
      console.log(`  ✅ Hotel ${mailbox.hotelId} → casilla ${mailbox.email ?? mailbox._id}`);
    } else {
      console.log(`  ⚠️  Hotel ${mailbox.hotelId} no encontrado (casilla ${mailbox._id})`);
    }
  }
  console.log(`   ${updated} hotel(es) actualizados\n`);

  // 2. Eliminar el índice único viejo hotelId_1
  console.log('─── Eliminando índice único hotelId_1 ─────────');
  try {
    const indexes = await mailboxes.indexes();
    const hotelIndex = indexes.find((i) => i.name === 'hotelId_1');
    if (hotelIndex) {
      await mailboxes.dropIndex('hotelId_1');
      console.log('  ✅ Índice hotelId_1 eliminado');
    } else {
      console.log('  ℹ️  El índice hotelId_1 no existe (ya fue eliminado)');
    }
  } catch (err) {
    console.log(`  ⚠️  No se pudo eliminar el índice: ${(err as Error).message}`);
  }
  console.log('');

  // 3. Limpiar el campo hotelId de las casillas
  console.log('─── Limpiando Mailbox.hotelId ─────────────────');
  const unset = await mailboxes.updateMany(
    { hotelId: { $exists: true } },
    { $unset: { hotelId: '' } },
  );
  console.log(`  ✅ ${unset.modifiedCount} casilla(s) limpiadas\n`);

  console.log('─────────────────────────────────────────────');
  console.log('✅ Migración completada');

  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error('❌ Error en la migración:', err);
  process.exit(1);
});
