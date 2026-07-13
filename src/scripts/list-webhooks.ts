/**
 * Lista las suscripciones de webhook de Aurinko de cada casilla conectada.
 * Diagnóstico: muestra id, resource, notificationUrl, estado y fallos.
 *
 * Uso: npm run webhooks:list
 */
import * as mongoose from 'mongoose';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const AURINKO_BASE = 'https://api.aurinko.io/v1';
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';
const ALGORITHM = 'aes-256-cbc';

function decrypt(encryptedText: string, key: Buffer): string {
  const [ivHex, encryptedHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function main() {
  const rawKey = process.env.ENCRYPTION_KEY ?? '';
  if (rawKey.length !== 32) {
    console.error('ENCRYPTION_KEY debe tener 32 caracteres');
    process.exit(1);
  }
  const key = Buffer.from(rawKey, 'utf8');

  await mongoose.connect(MONGODB_URI);
  const MailboxModel = mongoose.model(
    'Mailbox',
    new mongoose.Schema({}, { strict: false }),
    'mailboxes',
  );

  const mailboxes = await MailboxModel.find({
    status: 'connected',
    active: true,
    accessToken: { $nin: [null, ''] },
  }).lean();

  for (const mb of mailboxes) {
    const m = mb as { email?: string; accessToken?: string; aurinkoAccountId?: number };
    console.log(`\n─── ${m.email} (accountId=${m.aurinkoAccountId ?? '?'}) ───`);
    let token: string;
    try {
      token = decrypt(m.accessToken as string, key);
    } catch {
      console.log('   ✖ no se pudo desencriptar el token');
      continue;
    }

    try {
      const acc = await axios.get(`${AURINKO_BASE}/account`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`   cuenta: ${acc.data?.email} type=${acc.data?.serviceType} active=${acc.data?.active} sync=${acc.data?.syncState ?? acc.data?.status ?? '?'}`);
    } catch (err) {
      console.log('   ✖ error al leer /account:', axios.isAxiosError(err) ? err.response?.data : err);
    }

    try {
      const { data } = await axios.get(`${AURINKO_BASE}/subscriptions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const records = Array.isArray(data) ? data : (data?.records ?? []);
      if (records.length === 0) {
        console.log('   (sin suscripciones)');
      }
      for (const s of records) {
        console.log(`   • sub id=${s.id} resource=${s.resource} active=${s.active ?? '?'}`);
        console.log(`     url=${s.notificationUrl ?? '?'}`);
        console.log(`     failedSince=${s.failSince ?? s.failedDeliverySince ?? '—'} lastNotified=${s.lastNotification ?? s.lastPush ?? '—'}`);
      }
    } catch (err) {
      console.log('   ✖ error al listar subscriptions:', axios.isAxiosError(err) ? err.response?.data : err);
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Error:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
