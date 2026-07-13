/**
 * Seed de templates de respuesta de prueba.
 * Crea un set variado de plantillas para cada hotel del tenant.
 * Idempotente: no duplica (clave tenantId + hotelId + name).
 *
 * Uso: npx ts-node src/scripts/seed-templates.ts
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

interface TemplateSeed {
  name: string;
  description: string;
  body: string;
  tags: string[];
}

const TEMPLATES: TemplateSeed[] = [
  {
    name: 'Disponibilidad y reservas',
    description:
      'Cuando el huésped consulta si hay habitaciones disponibles o quiere hacer/confirmar una reserva para determinadas fechas.',
    body: `Estimado/a huésped,

¡Gracias por su interés en hospedarse con nosotros! Con gusto le confirmamos que contamos con disponibilidad para las fechas consultadas.

Para avanzar con la reserva, ¿podría indicarnos la cantidad de huéspedes y el tipo de habitación de su preferencia? Así le enviamos la cotización y las opciones disponibles.

Quedamos atentos a su respuesta.

Saludos cordiales,`,
    tags: ['reserva', 'disponibilidad', 'habitaciones', 'fechas'],
  },
  {
    name: 'Tarifas y precios',
    description:
      'Cuando el huésped pregunta por el precio de las habitaciones, tarifas por noche, promociones o cotización.',
    body: `Estimado/a huésped,

¡Gracias por escribirnos! Le compartimos que nuestras tarifas varían según la temporada y el tipo de habitación.

Si nos indica las fechas exactas de su estadía y la cantidad de personas, le enviaremos una cotización personalizada con las mejores opciones y promociones vigentes.

Quedamos a su disposición.

Saludos cordiales,`,
    tags: ['tarifa', 'precio', 'cotización', 'promoción'],
  },
  {
    name: 'Horarios de check-in y check-out',
    description:
      'Cuando el huésped pregunta a qué hora puede ingresar (check-in) o hasta qué hora debe dejar la habitación (check-out), o sobre early check-in / late check-out.',
    body: `Estimado/a huésped,

¡Gracias por su consulta! Nuestro horario de check-in es a partir de las 15:00 hs y el check-out hasta las 11:00 hs.

Si necesita un ingreso anticipado o una salida más tardía, con gusto verificamos la disponibilidad según la ocupación del día. No dude en avisarnos.

Saludos cordiales,`,
    tags: ['check-in', 'check-out', 'horario', 'ingreso', 'salida'],
  },
  {
    name: 'Cancelación de reserva',
    description:
      'Cuando el huésped desea cancelar o modificar una reserva ya realizada, o consulta por la política de cancelación.',
    body: `Estimado/a huésped,

Lamentamos que deba cancelar su reserva. Con gusto lo asistimos con el proceso.

Nuestra política permite cancelaciones sin cargo hasta 48 hs antes de la fecha de llegada. Para gestionarla, por favor confírmenos el número de reserva y el nombre del titular.

Quedamos atentos para ayudarle.

Saludos cordiales,`,
    tags: ['cancelación', 'modificación', 'política', 'reembolso'],
  },
  {
    name: 'Servicios e instalaciones',
    description:
      'Cuando el huésped pregunta por los servicios del hotel: wifi, desayuno, piscina, estacionamiento, mascotas, gimnasio, etc.',
    body: `Estimado/a huésped,

¡Gracias por su interés! Nuestro hotel ofrece Wi-Fi gratuito en todas las áreas, desayuno buffet incluido, estacionamiento sin cargo y servicio de recepción 24 hs.

Si tiene alguna consulta específica sobre algún servicio en particular, con gusto le brindamos más detalles.

Saludos cordiales,`,
    tags: ['servicios', 'wifi', 'desayuno', 'piscina', 'estacionamiento', 'mascotas'],
  },
  {
    name: 'Ubicación y cómo llegar',
    description:
      'Cuando el huésped pregunta por la dirección del hotel, cómo llegar, transfer desde el aeropuerto o estacionamiento.',
    body: `Estimado/a huésped,

¡Con gusto le ayudamos! Nos encontramos en una ubicación de fácil acceso, a pocos minutos del centro.

Si nos indica su punto de partida y horario de llegada, podemos coordinar un servicio de transfer o brindarle indicaciones detalladas para llegar cómodamente.

Quedamos a su disposición.

Saludos cordiales,`,
    tags: ['ubicación', 'dirección', 'cómo llegar', 'transfer', 'aeropuerto'],
  },
];

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No DB connection');

  const hotelsCol = db.collection('hotels');
  const templatesCol = db.collection('response_templates');

  const hotels = await hotelsCol.find({}).toArray();
  if (hotels.length === 0) {
    console.log('No hay hoteles. Corré primero: npm run seed');
    await mongoose.disconnect();
    return;
  }

  let created = 0;
  let skipped = 0;
  const now = new Date();

  for (const hotel of hotels) {
    console.log(`\n─── ${hotel.name} (${hotel._id}) ───`);
    for (const tpl of TEMPLATES) {
      const exists = await templatesCol.findOne({
        tenantId: hotel.tenantId,
        hotelId: hotel._id,
        name: tpl.name,
      });
      if (exists) {
        console.log(`  ℹ️  ya existe: "${tpl.name}"`);
        skipped++;
        continue;
      }
      await templatesCol.insertOne({
        tenantId: hotel.tenantId,
        hotelId: hotel._id,
        name: tpl.name,
        description: tpl.description,
        body: tpl.body,
        tags: tpl.tags,
        active: true,
        createdBy: null,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`  ✅ creado: "${tpl.name}"`);
      created++;
    }
  }

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`✅ Templates creados: ${created} | ya existentes: ${skipped}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error en seed-templates:', err);
  process.exit(1);
});
