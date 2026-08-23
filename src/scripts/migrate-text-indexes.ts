/**
 * Reconstruye los índices de texto con default_language: 'spanish'.
 * Mongo no permite modificar un índice existente, así que se dropea y se
 * recrea con las mismas keys/weights + el idioma correcto.
 *
 * Idempotente: si el índice ya tiene default_language spanish, no hace nada.
 *
 * Uso: npx ts-node src/scripts/migrate-text-indexes.ts
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

interface TextIndexSpec {
  collection: string;
  name: string;
  keys: Record<string, 'text'>;
  weights: Record<string, number>;
}

const INDEXES: TextIndexSpec[] = [
  {
    collection: 'response_templates',
    name: 'response_template_text_idx',
    keys: { name: 'text', description: 'text', body: 'text', tags: 'text' },
    weights: { name: 10, description: 5, body: 3, tags: 4 },
  },
  {
    collection: 'messages',
    name: 'message_text_idx',
    keys: { subject: 'text', bodyPreview: 'text' },
    weights: { subject: 5, bodyPreview: 3 },
  },
];

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No DB connection');

  for (const spec of INDEXES) {
    const col = db.collection(spec.collection);
    const existing = (await col.indexes()).find((i) => i.name === spec.name);

    if (existing?.default_language === 'spanish') {
      console.log(`ℹ️  ${spec.collection}.${spec.name} ya está en spanish, sin cambios`);
      continue;
    }

    if (existing) {
      await col.dropIndex(spec.name);
      console.log(`🗑  ${spec.collection}.${spec.name} dropeado (default_language=${existing.default_language ?? 'english'})`);
    } else {
      console.log(`ℹ️  ${spec.collection}.${spec.name} no existía, se crea desde cero`);
    }

    await col.createIndex(spec.keys, {
      name: spec.name,
      weights: spec.weights,
      default_language: 'spanish',
    });
    console.log(`✅ ${spec.collection}.${spec.name} recreado con default_language=spanish`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error en migrate-text-indexes:', err);
  process.exit(1);
});
