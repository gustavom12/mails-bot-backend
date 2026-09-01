/**
 * Elimina un hotel y todo lo que cuelga de él, dejando las conversaciones
 * reasignables.
 *
 * Qué hace:
 *   1. Escribe un backup JSON con el hotel, sus templates y las conversaciones
 *      afectadas (para poder revertir a mano si hiciera falta).
 *   2. Pone `hotelId: null` en las conversaciones del hotel y limpia las marcas
 *      de auto-asignación, para que vuelvan al circuito de asignación.
 *   3. Borra los response templates del hotel (quedarían huérfanos).
 *   4. Borra el hotel.
 *
 * Es un DRY-RUN por defecto: muestra el impacto sin tocar nada. Con --apply
 * ejecuta los cambios.
 *
 * Uso:
 *   npm run hotel:delete -- --hotel <id> [--backup <ruta>] [--apply]
 *
 * Ejemplo:
 *   npm run hotel:delete -- --hotel 6a6c907067e6b21765faf495 --apply
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const hotelId = arg('hotel');
  const apply = process.argv.includes('--apply');
  if (!hotelId) {
    console.error('❌ Falta --hotel <id>');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No se pudo obtener la conexión a la base de datos');

  const oid = new mongoose.Types.ObjectId(hotelId);
  const hotel = await db.collection('hotels').findOne({ _id: oid });
  if (!hotel) {
    console.error(`❌ Hotel ${hotelId} no encontrado`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const templates = await db.collection('response_templates').find({ hotelId: oid }).toArray();
  const conversations = await db.collection('conversations').find({ hotelId: oid }).toArray();
  const usersWithPerm = await db
    .collection('users')
    .find({ 'hotelPermissions.hotelId': oid })
    .toArray();

  console.log(`\n─── Hotel a eliminar ──────────────────────────`);
  console.log(`  "${hotel.name}"  (${hotelId})  tenant=${hotel.tenantId}`);
  console.log(`  conversaciones asignadas: ${conversations.length}  → pasan a hotelId null`);
  console.log(`  response templates:       ${templates.length}  → se borran`);
  console.log(
    `  usuarios con permiso:     ${usersWithPerm.length}${usersWithPerm.length ? '  ⚠️  revisar a mano' : ''}`,
  );
  for (const c of conversations) {
    console.log(`    · ${c._id} "${String(c.subject ?? '').slice(0, 60)}"`);
  }
  for (const t of templates) {
    console.log(`    · template "${t.name}"`);
  }

  if (!apply) {
    console.log(`\n🔍 DRY-RUN: no se modificó nada. Volvé a correr con --apply.\n`);
    await mongoose.disconnect();
    return;
  }

  const backupPath = arg('backup') ?? path.resolve(process.cwd(), `backup-hotel-${hotelId}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ hotel, templates, conversations, usersWithPerm }, null, 2),
  );
  console.log(`\n💾 Backup escrito en ${backupPath}`);

  const unassigned = await db
    .collection('conversations')
    .updateMany(
      { hotelId: oid },
      { $set: { hotelId: null, hotelAutoAssigned: false, hotelAssignmentReason: null } },
    );
  console.log(`  ✅ ${unassigned.modifiedCount} conversación(es) liberadas`);

  const delTemplates = await db.collection('response_templates').deleteMany({ hotelId: oid });
  console.log(`  ✅ ${delTemplates.deletedCount} template(s) borrados`);

  await db.collection('hotels').deleteOne({ _id: oid });
  console.log(`  ✅ hotel "${hotel.name}" borrado\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
