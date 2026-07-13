/**
 * Seed script — crea datos de prueba completos.
 * Uso: npm run seed
 * Es idempotente: se puede correr múltiples veces sin duplicar datos.
 */
import * as mongoose from 'mongoose';
import * as bcrypt from 'bcrypt';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { DEFAULT_STATES } from '../conversation-states/conversation-states.service';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

// ─── Schemas mínimos para el seed ────────────────────────────────────────────

const TenantSchema = new mongoose.Schema({ name: String, active: Boolean }, { timestamps: true });

const UserSchema = new mongoose.Schema(
  {
    tenantId: mongoose.Schema.Types.ObjectId,
    email: String,
    password: String,
    name: String,
    role: String,
    hotelIds: [mongoose.Schema.Types.ObjectId],
    active: Boolean,
  },
  { timestamps: true },
);

const HotelSchema = new mongoose.Schema(
  {
    tenantId: mongoose.Schema.Types.ObjectId,
    name: String,
    tone: String,
    signature: String,
    brandInfo: String,
    aiRules: [String],
    active: Boolean,
  },
  { timestamps: true },
);

const MailboxSchema = new mongoose.Schema(
  {
    tenantId: mongoose.Schema.Types.ObjectId,
    hotelId: mongoose.Schema.Types.ObjectId,
    email: String,
    status: String,
    accessToken: String,
    refreshToken: String,
    tokenExpiresAt: Date,
    active: Boolean,
  },
  { timestamps: true },
);

// ─── Datos ───────────────────────────────────────────────────────────────────

const TENANT_NAME = 'Demo Hotel Group';

const USERS = [
  { email: 'owner@example.com', password: 'Admin1234!', name: 'Carlos Ramírez', role: 'owner' },
  { email: 'admin@example.com', password: 'Admin1234!', name: 'Laura González', role: 'admin' },
];

const HOTELS = [
  {
    name: 'Hotel Patagonia',
    tone: 'Cálido, cercano y profesional. Transmitir la experiencia única de la Patagonia.',
    signature: 'El equipo de Hotel Patagonia\nreservas@hotelpatagonia.com | +54 11 4000-1111',
    brandInfo:
      'Hotel boutique de 5 estrellas ubicado en Bariloche. Especializado en turismo de aventura y naturaleza. Capacidad para 80 huéspedes.',
    aiRules: [
      'Siempre saludar al cliente por su nombre si está disponible',
      'No confirmar disponibilidad sin verificar en el sistema',
      'Mencionar actividades de temporada cuando sea relevante',
      'Responder siempre en el idioma del cliente',
    ],
  },
  {
    name: 'Hotel Buenos Aires Palace',
    tone: 'Elegante, formal y sofisticado. Refleja la distinción del hotel más emblemático de la ciudad.',
    signature: 'Relaciones con Huéspedes — Hotel Buenos Aires Palace\ninfo@bsaspalace.com | +54 11 5200-2222',
    brandInfo:
      'Hotel de lujo de 5 estrellas en el corazón de Puerto Madero. 120 habitaciones y suites. Referente del turismo ejecutivo y de negocios.',
    aiRules: [
      'Mantener siempre un tono formal y elegante',
      'Ofrecer servicio de concierge ante cualquier consulta de actividades',
      'Para grupos de más de 10 personas, derivar al área de eventos',
      'No compartir información de otros huéspedes bajo ninguna circunstancia',
    ],
  },
  {
    name: 'Hotel Mendoza Vines',
    tone: 'Apasionado, enológico y experiencial. El vino y la naturaleza como protagonistas.',
    signature: 'Bienvenidos a Mendoza Vines\nexperiencias@mendozavines.com | +54 261 300-3333',
    brandInfo:
      'Boutique hotel & winery en Luján de Cuyo, Mendoza. 40 habitaciones premium rodeadas de viñedos. Foco en enoturismo y gastronomía de autor.',
    aiRules: [
      'Siempre mencionar la bodega y las experiencias de degustación disponibles',
      'Las reservas de cenas en el restaurante requieren confirmación 48hs antes',
      'Responder con entusiasmo consultas sobre vinos y maridajes',
      'El check-in es a las 15hs y el check-out a las 11hs',
    ],
  },
];

const MAILBOX_EMAILS = [
  'reservas@hotelpatagonia.com',
  'info@bsaspalace.com',
  'experiencias@mendozavines.com',
];

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  const StateSchema = new mongoose.Schema(
    { tenantId: mongoose.Schema.Types.ObjectId, name: String, color: String, order: Number, isDefault: Boolean, isClosed: Boolean, active: Boolean },
    { timestamps: true },
  );

  const TenantModel = mongoose.model('Tenant', TenantSchema, 'tenants');
  const UserModel = mongoose.model('User', UserSchema, 'users');
  const StateModel = mongoose.model('ConversationState', StateSchema, 'conversation_states');
  const HotelModel = mongoose.model('Hotel', HotelSchema, 'hotels');
  const MailboxModel = mongoose.model('Mailbox', MailboxSchema, 'mailboxes');

  // 1. Tenant
  let tenant = await TenantModel.findOne({ name: TENANT_NAME });
  if (!tenant) {
    tenant = await TenantModel.create({ name: TENANT_NAME, active: true });
    console.log(`✅ Tenant: ${tenant.name} (${tenant._id})`);
  } else {
    console.log(`ℹ️  Tenant ya existe: ${tenant.name} (${tenant._id})`);
  }

  const tenantId = tenant._id;

  // 2. Hotels
  console.log('\n─── Hoteles ───────────────────────────────────');
  const hotelIds: mongoose.Types.ObjectId[] = [];

  for (const hotelData of HOTELS) {
    let hotel = await HotelModel.findOne({ tenantId, name: hotelData.name });
    if (!hotel) {
      hotel = await HotelModel.create({ tenantId, ...hotelData, active: true });
      console.log(`✅ Hotel creado: ${hotel.name} (${hotel._id})`);
    } else {
      console.log(`ℹ️  Hotel ya existe: ${hotel.name} (${hotel._id})`);
    }
    hotelIds.push(hotel._id as mongoose.Types.ObjectId);
  }

  // 3. Mailboxes
  console.log('\n─── Casillas ──────────────────────────────────');
  for (let i = 0; i < hotelIds.length; i++) {
    const email = MAILBOX_EMAILS[i];
    const hotelId = hotelIds[i];

    let mailbox = await MailboxModel.findOne({ tenantId, email });
    if (!mailbox) {
      mailbox = await MailboxModel.create({
        tenantId,
        hotelId,
        email,
        status: 'pending',
        active: true,
      });
      console.log(`✅ Casilla creada: ${mailbox.email} → Hotel[${i + 1}] (${mailbox._id})`);
    } else {
      console.log(`ℹ️  Casilla ya existe: ${mailbox.email}`);
    }
  }

  // 4. Users
  console.log('\n─── Usuarios ──────────────────────────────────');
  for (const userData of USERS) {
    let user = await UserModel.findOne({ email: userData.email, tenantId });
    if (!user) {
      const hashed = await bcrypt.hash(userData.password, 12);
      user = await UserModel.create({
        tenantId,
        email: userData.email,
        password: hashed,
        name: userData.name,
        role: userData.role,
        hotelIds: userData.role === 'admin' ? [hotelIds[0]] : hotelIds,
        active: true,
      });
      console.log(`✅ Usuario creado: ${user.name} (${user.role}) — ${user.email}`);
    } else {
      // Actualizar hotelIds si el usuario ya existe
      await UserModel.updateOne(
        { _id: user._id },
        { hotelIds: userData.role === 'admin' ? [hotelIds[0]] : hotelIds },
      );
      console.log(`ℹ️  Usuario ya existe: ${user.email} (hotelIds actualizados)`);
    }
  }

  // 5. Estados de conversación por defecto
  console.log('\n─── Estados ───────────────────────────────────');
  const existingStates = await StateModel.countDocuments({ tenantId });
  if (existingStates === 0) {
    await StateModel.insertMany(DEFAULT_STATES.map((s) => ({ ...s, tenantId, active: true })));
    console.log(`✅ ${DEFAULT_STATES.length} estados por defecto creados`);
  } else {
    console.log(`ℹ️  Los estados ya existen (${existingStates})`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('✅ Seed completado\n');
  console.log('Credenciales:');
  for (const u of USERS) {
    console.log(`  ${u.role.padEnd(6)} → ${u.email} / ${u.password}`);
  }

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('❌ Error en seed:', err);
  process.exit(1);
});
