/**
 * Migración: recalcula `unread` y `lastMessageDirection` de las conversaciones.
 *
 * - lastMessageDirection = dirección del último mensaje ('inbound' | 'outbound').
 * - unread=true si el último mensaje es inbound (del cliente, esperando respuesta);
 *   si es outbound (ya respondida), queda como leída (unread=false).
 *
 * Uso:
 *   npm run migrate:unread
 *
 * Variables de entorno (opcionales):
 *   MONGODB_URI → DB a actualizar (default: el del .env)
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

async function run() {
  console.log(`🔌 Conectando a ${MONGODB_URI.replace(/\/\/[^@]*@/, '//***@')}…\n`);
  const conn = await mongoose.createConnection(MONGODB_URI).asPromise();
  const db = conn.db;
  if (!db) throw new Error('No se pudo obtener el handle de la DB');

  const conversations = db.collection('conversations');
  const messages = db.collection('messages');

  const all = await conversations.find({}, { projection: { _id: 1 } }).toArray();
  console.log(`📦 ${all.length} conversación(es) encontradas\n`);

  let unread = 0;
  let read = 0;

  for (const conv of all) {
    const lastMsg = await messages
      .find({ conversationId: conv._id })
      .sort({ receivedAt: -1 })
      .limit(1)
      .toArray();

    // Sin mensajes → la tratamos como no leída / inbound (caso borde)
    const lastDirection: 'inbound' | 'outbound' =
      lastMsg.length > 0 && lastMsg[0].direction === 'outbound' ? 'outbound' : 'inbound';
    const isUnread = lastDirection === 'inbound';

    await conversations.updateOne(
      { _id: conv._id },
      { $set: { unread: isUnread, lastMessageDirection: lastDirection } },
    );
    if (isUnread) unread++;
    else read++;
  }

  console.log('─────────────────────────────────────────────');
  console.log(`✅ Actualizadas — no leídas: ${unread}, leídas: ${read}`);

  await conn.close();
}

run().catch((err) => {
  console.error('❌ Error en la migración:', err);
  process.exit(1);
});
