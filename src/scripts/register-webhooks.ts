/**
 * (Re)registra los webhooks de Aurinko para todas las casillas conectadas.
 *
 * Qué hace:
 *  1. Se conecta a Mongo y busca las casillas `connected` + `active` con token.
 *  2. Desencripta el access token de cada casilla (misma lógica que EncryptionService).
 *  3. Lista las suscripciones existentes de esa cuenta y borra las que apuntan
 *     a /email/messages (típicamente la vieja que quedó `inactive`).
 *  4. Crea una suscripción nueva apuntando a <PUBLIC_URL>/api/aurinko/webhook,
 *     lo que dispara el handshake de verificación contra el túnel vivo.
 *
 * Uso:
 *   npm run webhooks:register -- https://mi-url-publica.trycloudflare.com
 *   # o vía env:
 *   WEBHOOK_PUBLIC_URL=https://mi-url-publica.loca.lt npm run webhooks:register
 */
import * as mongoose from 'mongoose';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';
import * as path from 'path';
import axios from 'axios';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const AURINKO_BASE = 'https://api.aurinko.io/v1';
const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';
const WEBHOOK_RESOURCE = '/email/messages';

// ─── Desencriptado (replica EncryptionService) ───────────────────────────────
const ALGORITHM = 'aes-256-cbc';

function decrypt(encryptedText: string, key: Buffer): string {
  const [ivHex, encryptedHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ─── Aurinko API helpers ─────────────────────────────────────────────────────
function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

interface AurinkoSubscription {
  id: number | string;
  resource: string;
  notificationUrl?: string;
  active?: boolean;
}

async function listSubscriptions(token: string): Promise<AurinkoSubscription[]> {
  try {
    const { data } = await axios.get(`${AURINKO_BASE}/subscriptions`, { headers: authHeaders(token) });
    if (Array.isArray(data)) return data as AurinkoSubscription[];
    return (data?.records ?? []) as AurinkoSubscription[];
  } catch (err) {
    logAxiosError('listar suscripciones', err);
    return [];
  }
}

async function deleteSubscription(token: string, id: number | string): Promise<void> {
  await axios.delete(`${AURINKO_BASE}/subscriptions/${id}`, { headers: authHeaders(token) });
}

async function createSubscription(
  token: string,
  notificationUrl: string,
): Promise<AurinkoSubscription> {
  const { data } = await axios.post(
    `${AURINKO_BASE}/subscriptions`,
    { resource: WEBHOOK_RESOURCE, notificationUrl },
    { headers: { ...authHeaders(token), 'Content-Type': 'application/json' } },
  );
  return data as AurinkoSubscription;
}

function logAxiosError(context: string, err: unknown): void {
  if (axios.isAxiosError(err)) {
    console.error(
      `   ✖ Error al ${context}: ${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`,
    );
  } else {
    console.error(`   ✖ Error al ${context}:`, err);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const rawUrl = process.argv[2] ?? process.env.WEBHOOK_PUBLIC_URL ?? '';
  const baseUrl = rawUrl.trim().replace(/\/+$/, '');

  if (!baseUrl) {
    console.error(
      'Falta la URL pública.\n' +
        'Uso: npm run webhooks:register -- https://mi-url-publica\n' +
        '  o: WEBHOOK_PUBLIC_URL=https://mi-url-publica npm run webhooks:register',
    );
    process.exit(1);
  }
  if (!/^https:\/\//.test(baseUrl)) {
    console.error(`La URL debe ser https:// — recibido: "${baseUrl}"`);
    process.exit(1);
  }

  const rawKey = process.env.ENCRYPTION_KEY ?? '';
  if (rawKey.length !== 32) {
    console.error('ENCRYPTION_KEY debe tener exactamente 32 caracteres (revisá el .env)');
    process.exit(1);
  }
  const key = Buffer.from(rawKey, 'utf8');

  const webhookUrl = `${baseUrl}/api/aurinko/webhook`;
  console.log(`\n🔗 URL de webhook a registrar: ${webhookUrl}\n`);

  await mongoose.connect(MONGODB_URI);

  const MailboxSchema = new mongoose.Schema(
    {
      email: String,
      status: String,
      accessToken: String,
      active: Boolean,
      aurinkoAccountId: Number,
    },
    { timestamps: true, strict: false },
  );
  const MailboxModel = mongoose.model('Mailbox', MailboxSchema, 'mailboxes');

  const mailboxes = await MailboxModel.find({
    status: 'connected',
    active: true,
    accessToken: { $nin: [null, ''] },
  }).lean();

  if (mailboxes.length === 0) {
    console.log('No hay casillas conectadas con token. Conectá una casilla primero (OAuth).');
    await mongoose.disconnect();
    return;
  }

  console.log(`Encontradas ${mailboxes.length} casilla(s) conectada(s).\n`);

  let ok = 0;
  let failed = 0;

  for (const mb of mailboxes) {
    const email = (mb as { email?: string }).email ?? '(sin email)';
    const encrypted = (mb as { accessToken?: string }).accessToken;
    console.log(`─── ${email} ───`);

    if (!encrypted) {
      console.log('   ⊘ sin accessToken, se omite');
      continue;
    }

    let token: string;
    try {
      token = decrypt(encrypted, key);
    } catch {
      console.log('   ✖ no se pudo desencriptar el token (¿ENCRYPTION_KEY correcta?)');
      failed++;
      continue;
    }

    // 1. Borrar suscripciones previas al mismo recurso (limpia las inactivas)
    const existing = await listSubscriptions(token);
    const stale = existing.filter((s) => s.resource === WEBHOOK_RESOURCE);
    for (const sub of stale) {
      try {
        await deleteSubscription(token, sub.id);
        console.log(`   🗑  borrada suscripción vieja id=${sub.id}`);
      } catch (err) {
        logAxiosError(`borrar suscripción id=${sub.id}`, err);
      }
    }

    // 2. Crear la nueva (dispara el handshake de verificación)
    try {
      const sub = await createSubscription(token, webhookUrl);
      console.log(`   ✅ suscripción creada id=${sub.id} resource=${sub.resource}`);
      ok++;
    } catch (err) {
      logAxiosError('crear suscripción', err);
      console.log('   ↳ Verificá que el túnel esté vivo y devuelva 200 al validationToken.');
      failed++;
    }
    console.log('');
  }

  console.log('─────────────────────────────────────────────');
  console.log(`✅ Webhooks registrados: ${ok} | con error: ${failed}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Error en register-webhooks:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
