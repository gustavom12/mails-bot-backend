/**
 * Clona una base de datos completa hacia otra, dejándola IDÉNTICA al origen.
 *
 * ⚠️  DESTRUCTIVO: elimina todas las colecciones/datos del destino y las
 * reemplaza por una copia exacta del origen (mismos _id, índices y documentos).
 *
 * Uso:
 *   npm run clone:db
 *
 * Variables de entorno (opcionales, con defaults):
 *   CLONE_SOURCE_URI → DB origen  (default: mongodb://localhost:27017/mails-bot)
 *   CLONE_DEST_URI   → DB destino (default: MONGODB_URI del .env)
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const SOURCE_URI =
  process.env.CLONE_SOURCE_URI ?? 'mongodb://localhost:27017/mails-bot';
const DEST_URI =
  process.env.CLONE_DEST_URI ??
  process.env.MONGODB_URI ??
  'mongodb+srv://mails-bot:fu7tMeidd5HWXivL@mails-bot.tbimvlx.mongodb.net/?appName=mails-bot';

const mask = (uri: string) => uri.replace(/\/\/[^@]*@/, '//***@');

async function cloneDb() {
  console.log('🔌 Conectando…');
  console.log(`   origen : ${mask(SOURCE_URI)}`);
  console.log(`   destino: ${mask(DEST_URI)}\n`);

  const source = await mongoose.createConnection(SOURCE_URI).asPromise();
  const dest = await mongoose.createConnection(DEST_URI).asPromise();

  const sourceDb = source.db;
  const destDb = dest.db;
  if (!sourceDb || !destDb) throw new Error('No se pudo obtener el handle de la DB');

  // 1. Vaciar el destino por completo.
  console.log('🧹 Limpiando destino…');
  const destCollections = await destDb.listCollections().toArray();
  for (const { name } of destCollections) {
    await destDb.dropCollection(name);
    console.log(`  🗑️  ${name} eliminada`);
  }
  if (destCollections.length === 0) console.log('  (destino ya estaba vacío)');
  console.log('');

  // 2. Copiar cada colección del origen.
  console.log('📦 Copiando colecciones del origen…');
  const sourceCollections = await sourceDb
    .listCollections({ type: 'collection' })
    .toArray();

  for (const { name } of sourceCollections) {
    const docs = await sourceDb.collection(name).find({}).toArray();
    if (docs.length > 0) {
      await destDb.collection(name).insertMany(docs, { ordered: false });
    } else {
      await destDb.createCollection(name);
    }

    // Replicar índices (además del _id por defecto).
    const indexes = await sourceDb.collection(name).indexes();
    for (const idx of indexes) {
      if (idx.name === '_id_') continue;
      const { key, name: idxName, v, ...options } = idx as any;
      try {
        await destDb.collection(name).createIndex(key, { name: idxName, ...options });
      } catch (e: any) {
        console.log(`     ⚠️  índice ${idxName} en ${name}: ${e.message}`);
      }
    }

    console.log(`  ✅ ${name}: ${docs.length} documento(s)`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('✅ Clonación completada — el destino es idéntico al origen');

  await source.close();
  await dest.close();
}

cloneDb().catch((err) => {
  console.error('❌ Error en la clonación:', err);
  process.exit(1);
});
