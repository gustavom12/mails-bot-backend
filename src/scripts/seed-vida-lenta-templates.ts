/**
 * Seed de templates de respuesta para el tenant "Vida lenta".
 * Crea 8 templates por hotel (cotización de grupo, disponibilidad/tarifas,
 * eventos, servicios, check-in/out, políticas, buyout y seguimiento) con la
 * información de la "Guia_Cotizacion_Vida_Lenta (2).xlsx".
 *
 * Idempotente: no duplica (clave tenantId + hotelId + name).
 * Excluye el hotel legacy "Vidalenta".
 *
 * Uso: npx ts-node src/scripts/seed-vida-lenta-templates.ts
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';

const TENANT_ID = '6a6bf9b2f89d1d90ed0a2aba';
const LEGACY_HOTEL_NAME = 'Vidalenta';

interface TemplateSeed {
  name: string;
  description: string;
  body: string;
  tags: string[];
}

interface HotelData {
  /** Nombre exacto del hotel en la colección `hotels`. */
  dbName: string;
  zona: string;
  direccion: string;
  totalHabitaciones: number;
  /** Lista "Tipo — cantidad" del inventario. */
  inventario: string[];
  minHabitacionesGrupo: number;
  /** null = no incluye desayuno. */
  desayuno: string | null;
  restauranteBar: string | null;
  elevador: boolean;
  /** Política de mascotas específica del hotel. */
  mascotas: string;
  /** Política de niños específica del hotel. */
  ninos: string;
  /** Notas extra para el template de servicios (ej. cunas, cocina en suites). */
  notasServicios: string[];
  /** Template de eventos completo, específico por hotel. */
  eventos: TemplateSeed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Builders de templates comunes (parametrizados por hotel)
// ─────────────────────────────────────────────────────────────────────────────

const DATOS_COTIZACION_HTML = `<ul>
<li>Fechas de llegada y salida</li>
<li>Número de habitaciones y número total de huéspedes</li>
<li>Distribución de camas (single / double / king / queen)</li>
<li>Edades de los menores, si viajan niños</li>
<li>Si requieren desayuno</li>
<li>Motivo o perfil del grupo (corporativo, placer, boda, producción, etc.)</li>
<li>Si necesitan salón o espacio para evento</li>
<li>Nombre de la empresa o agencia y, si aplica, comisión requerida</li>
<li>Fecha límite para tomar la decisión</li>
</ul>`;

function cotizacionGrupo(h: HotelData): TemplateSeed {
  return {
    name: 'Cotización de grupo — solicitud de datos',
    description:
      'Cuando el cliente pide cotización para un grupo, bloqueo de habitaciones, viaje corporativo, boda, producción o reserva de varias habitaciones y falta información para cotizar.',
    body: `<p>¡Hola! Muchas gracias por su interés en ${h.dbName}.</p>
<p>Con gusto preparamos una cotización para su grupo. En ${h.dbName} consideramos grupo a partir de ${h.minHabitacionesGrupo} habitaciones, y contamos con ${h.totalHabitaciones} habitaciones en total (máximo 2 personas por habitación).</p>
<p>Para poder cotizar y revisar disponibilidad, ¿nos podría compartir los siguientes datos?</p>
${DATOS_COTIZACION_HTML}
<p>Le comentamos que nuestras tarifas son dinámicas y se cotizan en MXN (incluyen IVA e ISH), por lo que pueden variar hasta que el grupo quede confirmado. La disponibilidad también puede cambiar hasta que el bloqueo esté garantizado.</p>
<p>Quedamos atentos a su información para enviarle la propuesta.</p>`,
    tags: ['cotización', 'grupo', 'grupos', 'bloqueo', 'corporativo', 'boda', 'rooming', 'quote', 'group'],
  };
}

function disponibilidadTarifas(h: HotelData): TemplateSeed {
  const inventarioHtml = h.inventario.map((i) => `<li>${i}</li>`).join('\n');
  const desayunoLinea = h.desayuno
    ? `<p>La tarifa incluye desayuno (${h.desayuno}).</p>`
    : '<p>Nuestras tarifas no incluyen desayuno.</p>';
  return {
    name: 'Disponibilidad y tarifas',
    description:
      'Cuando el cliente consulta disponibilidad, precios, tarifas por noche o quiere reservar una o pocas habitaciones para fechas determinadas.',
    body: `<p>¡Hola! Gracias por escribir a ${h.dbName}.</p>
<p>Con gusto revisamos disponibilidad para sus fechas. Nuestras tarifas son dinámicas: varían según la temporada y la fecha exacta, se cotizan en MXN e incluyen IVA e ISH. Para enviarle una cotización precisa, ¿nos confirma fechas de llegada y salida, número de huéspedes y tipo de habitación de su preferencia?</p>
<p>Contamos con ${h.totalHabitaciones} habitaciones (máximo 2 personas por habitación) en las siguientes categorías:</p>
<ul>
${inventarioHtml}
</ul>
${desayunoLinea}
<p>Quedamos atentos a sus fechas para confirmar disponibilidad y tarifa.</p>`,
    tags: ['disponibilidad', 'tarifa', 'precio', 'reserva', 'habitación', 'noche', 'availability', 'rate', 'booking'],
  };
}

function serviciosInfo(h: HotelData): TemplateSeed {
  const items: string[] = [];
  items.push(`<li><strong>Ubicación:</strong> ${h.direccion} (${h.zona}).</li>`);
  items.push(
    h.desayuno
      ? `<li><strong>Desayuno:</strong> incluido, ${h.desayuno}. Las opciones sin gluten, veganas o por alergias alimentarias se solicitan con anticipación, antes de la llegada.</li>`
      : '<li><strong>Desayuno:</strong> no está incluido ni se ofrece en el hotel.</li>',
  );
  if (h.restauranteBar) {
    items.push(`<li><strong>Restaurante / bar:</strong> ${h.restauranteBar}.</li>`);
  }
  items.push(`<li><strong>Elevador:</strong> ${h.elevador ? 'sí' : 'no'}.</li>`);
  items.push('<li><strong>Estacionamiento:</strong> no contamos con estacionamiento propio.</li>');
  items.push(`<li><strong>Mascotas:</strong> ${h.mascotas}</li>`);
  items.push(`<li><strong>Niños:</strong> ${h.ninos}</li>`);
  items.push(
    '<li><strong>Accesibilidad:</strong> no contamos con habitaciones adaptadas para movilidad reducida.</li>',
  );
  items.push('<li><strong>Equipaje:</strong> ofrecemos resguardo de equipaje antes del check-in y después del check-out.</li>');
  items.push('<li><strong>Recepción / seguridad:</strong> 24 horas.</li>');
  items.push('<li><strong>Política de humo:</strong> somos un hotel 100% libre de humo; fumar en las instalaciones genera penalización.</li>');
  for (const nota of h.notasServicios) items.push(`<li>${nota}</li>`);
  return {
    name: 'Servicios e información del hotel',
    description:
      'Cuando el cliente pregunta por servicios o características del hotel: desayuno, restaurante, ubicación, dirección, elevador, estacionamiento, mascotas, niños, accesibilidad, wifi o amenidades.',
    body: `<p>¡Hola! Gracias por su interés en ${h.dbName}. Le compartimos la información de nuestros servicios:</p>
<ul>
${items.join('\n')}
</ul>
<p>Si tiene alguna consulta adicional, con gusto le ayudamos.</p>`,
    tags: ['servicios', 'desayuno', 'ubicación', 'dirección', 'mascotas', 'niños', 'estacionamiento', 'elevador', 'amenidades', 'restaurante'],
  };
}

function checkInOut(h: HotelData): TemplateSeed {
  return {
    name: 'Check-in y check-out',
    description:
      'Cuando el cliente pregunta a qué hora puede ingresar (check-in), hasta qué hora debe dejar la habitación (check-out), o solicita early check-in o late check-out.',
    body: `<p>¡Hola! Gracias por su consulta.</p>
<p>En ${h.dbName} el horario de check-in es a partir de las <strong>3:00 pm</strong> y el check-out hasta las <strong>12:00 pm</strong>.</p>
<p>Podemos ofrecer early check-in o late check-out sujetos a disponibilidad; con gusto lo revisamos para su fecha de llegada o salida.</p>
<p>Los cambios de nombres o rooming list se pueden realizar hasta 24 horas antes del check-in.</p>
<p>Quedamos a sus órdenes.</p>`,
    tags: ['check-in', 'check-out', 'horario', 'ingreso', 'salida', 'early', 'late'],
  };
}

function politicas(h: HotelData): TemplateSeed {
  return {
    name: 'Políticas de reserva, depósito y cancelación',
    description:
      'Cuando el cliente pregunta por condiciones de reserva: depósito o anticipo, política de cancelación, no-show, formas de pago, moneda, impuestos o facturación.',
    body: `<p>¡Hola! Con gusto le compartimos nuestras condiciones de reserva:</p>
<ul>
<li><strong>Depósito:</strong> para garantizar habitaciones se requiere un depósito del 30%. Para eventos, el depósito es del 50%.</li>
<li><strong>Cancelación:</strong> entre 30 y 45 días antes de la llegada, según las condiciones que se definan al confirmar el grupo. Las condiciones exactas se detallan en la cotización.</li>
<li><strong>No-show:</strong> en reservas individuales se cobra una noche de penalidad; en grupos se cobra la primera noche del depósito de garantía.</li>
<li><strong>Cambios:</strong> los cambios de nombres o rooming list se aceptan hasta 24 horas antes del check-in.</li>
<li><strong>Fechas límite:</strong> la confirmación del grupo se solicita con 1 semana de anticipación; la liberación de habitaciones sigue la política de cancelación.</li>
<li><strong>Formas de pago:</strong> depósitos, transferencias y tarjeta de crédito o débito.</li>
<li><strong>Moneda e impuestos:</strong> cotizamos y cargamos en MXN (podemos cotizar en USD al tipo de cambio del día, pero el cargo se realiza en MXN). Las tarifas incluyen IVA e ISH.</li>
<li><strong>Facturación:</strong> para facturar, nos puede enviar su constancia de situación fiscal a este mismo correo.</li>
</ul>
<p>La disponibilidad puede cambiar hasta que la reserva o el grupo quede confirmado. Cualquier duda quedamos atentos.</p>`,
    tags: ['política', 'cancelación', 'depósito', 'anticipo', 'no-show', 'pago', 'facturación', 'impuestos', 'reembolso'],
  };
}

function buyout(h: HotelData): TemplateSeed {
  return {
    name: 'Buyout / renta total del hotel',
    description:
      'Cuando el cliente pregunta por rentar el hotel completo, renta total, privatización de la propiedad o buyout para un grupo o evento.',
    body: `<p>¡Hola! Gracias por su interés en ${h.dbName}.</p>
<p>Sí ofrecemos la renta total de la propiedad (buyout): ${h.dbName} cuenta con ${h.totalHabitaciones} habitaciones, con capacidad máxima de 2 personas por habitación.</p>
<p>La disponibilidad y las condiciones para un buyout se confirman internamente según las fechas, por lo que le pedimos considerar que debemos validarlo antes de poder ofrecerlo en firme. Tenga en cuenta que no tomamos grupos durante la Fórmula 1 (octubre) ni durante Art Week (febrero).</p>
<p>Para avanzar, ¿nos comparte fechas tentativas, número de huéspedes y el motivo del viaje o evento? Con esa información revisamos la disponibilidad y le preparamos una propuesta.</p>
<p>Quedamos atentos.</p>`,
    tags: ['buyout', 'renta total', 'hotel completo', 'privatización', 'exclusividad', 'full buyout'],
  };
}

function seguimiento(h: HotelData): TemplateSeed {
  return {
    name: 'Seguimiento de cotización',
    description:
      'Seguimiento amable cuando el cliente no respondió a una cotización o propuesta enviada por el hotel.',
    body: `<p>¡Hola! Esperamos que se encuentre muy bien.</p>
<p>Le escribimos para dar seguimiento a la información que le compartimos sobre ${h.dbName}. ¿Tuvo oportunidad de revisarla?</p>
<p>Tenga en cuenta que las tarifas son dinámicas y la disponibilidad puede cambiar hasta confirmar la reserva, por lo que con gusto actualizamos la propuesta o resolvemos cualquier duda para ayudarle a tomar una decisión.</p>
<p>Quedamos pendientes de sus comentarios.</p>`,
    tags: ['seguimiento', 'follow-up', 'followup', 'recordatorio'],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Datos por hotel (Guia_Cotizacion_Vida_Lenta)
// ─────────────────────────────────────────────────────────────────────────────

const HOTELES: HotelData[] = [
  {
    dbName: 'Hotel Parian',
    zona: 'Roma Norte',
    direccion: 'Av. Álvaro Obregón 130, Roma Norte, Cuauhtémoc, 06700 Ciudad de México, CDMX',
    totalHabitaciones: 19,
    inventario: [
      'Standard Queen — 11',
      'Standard King — 5',
      'Queen Street View — 1',
      'Double Suite Street View — 1',
      'King Suite Street View — 1',
    ],
    minHabitacionesGrupo: 4,
    desayuno: 'desayuno continental servido en la terraza',
    restauranteBar: 'sí; además estamos dentro del histórico Pasaje Parián, rodeados de restaurantes, galerías y estudios creativos',
    elevador: true,
    mascotas: 'aceptamos mascotas con un cargo de $800 MXN por estancia.',
    ninos: 'somos un hotel kids friendly. No contamos con camas extra.',
    notasServicios: [],
    eventos: {
      name: 'Eventos y celebraciones',
      description:
        'Cuando el cliente pregunta por organizar un evento, cóctel, celebración, propuesta, cena privada o reunión en el hotel.',
      body: `<p>¡Hola! Gracias por pensar en Hotel Parian para su evento.</p>
<p>Sí recibimos eventos en nuestra terraza, en formato cóctel (sentado, de pie o mixto) para un máximo de <strong>30 personas</strong> y hasta las <strong>22:00 hrs</strong>, por respeto al descanso de nuestros huéspedes. El servicio incluye canapés y bebidas, con opción de barra abierta o cerrada; también organizamos cenas privadas, propuestas y celebraciones con los menús de los restaurantes del pasaje.</p>
<p>Algunos puntos a considerar:</p>
<ul>
<li>Los eventos se reservan con al menos 15 días de anticipación.</li>
<li>El montaje y el mobiliario se cotizan por separado.</li>
<li>Se permiten proveedores externos (decoración, florista, DJ, fotógrafo) y también contamos con proveedores propios si lo necesita.</li>
<li>No contamos con equipo audiovisual propio ni salones interiores.</li>
<li>Para confirmar un evento se requiere un depósito del 50%.</li>
</ul>
<p>Para cotizarle, ¿nos comparte fecha, número de personas, tipo de evento, formato, horario y si además necesitan hospedaje? La capacidad y disponibilidad del espacio se confirman según la fecha, de forma independiente a la disponibilidad de habitaciones.</p>
<p>Quedamos atentos.</p>`,
      tags: ['evento', 'eventos', 'cóctel', 'celebración', 'cena privada', 'propuesta', 'terraza', 'banquete', 'event'],
    },
  },
  {
    dbName: 'Hotel Dama',
    zona: 'La Condesa',
    direccion: 'Zamora 94, Colonia Condesa, Cuauhtémoc, 06140 Ciudad de México, CDMX',
    totalHabitaciones: 17,
    inventario: [
      'Standard Balcony King — 2',
      'Standard Courtyard King — 1',
      'Standard Balcony Double Queen — 2',
      'Superior Balcony King — 6',
      'Superior Courtyard King — 2',
      'Superior Courtyard Double Queen — 1',
      'Premium Courtyard Double Queen — 1',
      'Premium Balcony King — 2',
    ],
    minHabitacionesGrupo: 4,
    desayuno: 'desayuno continental con opciones calientes, servido en la terraza',
    restauranteBar: 'sí; contamos con restaurante y una de las terrazas más reconocidas del barrio',
    elevador: true,
    mascotas: 'aceptamos mascotas con un cargo de $800 MXN por estancia.',
    ninos: 'somos un hotel kids friendly y contamos con cunas disponibles. No contamos con camas extra.',
    notasServicios: [],
    eventos: {
      name: 'Eventos y celebraciones',
      description:
        'Cuando el cliente pregunta por organizar un evento, cóctel, banquete, celebración, propuesta, cena privada o reunión en el hotel.',
      body: `<p>¡Hola! Gracias por pensar en Hotel Dama para su evento.</p>
<p>Sí recibimos eventos en nuestra terraza, una de las más reconocidas de La Condesa. Trabajamos formato cóctel (sentado, de pie o mixto) para un máximo de <strong>40 personas</strong> y hasta las <strong>22:00 hrs</strong>, por respeto al descanso de nuestros huéspedes. El cóctel incluye canapés y bebidas, con opción de barra abierta o cerrada, y para eventos sentados contamos con menú de 3 tiempos. También organizamos cenas privadas, propuestas y celebraciones, con menú de terraza y menú de banquetes disponibles.</p>
<p>Algunos puntos a considerar:</p>
<ul>
<li>Los eventos se reservan con al menos 15 días de anticipación.</li>
<li>El montaje y el mobiliario se cotizan por separado.</li>
<li>Se permiten proveedores externos (decoración, florista, DJ, fotógrafo) y también contamos con proveedores propios si lo necesita.</li>
<li>No contamos con equipo audiovisual propio ni salones interiores.</li>
<li>Para confirmar un evento se requiere un depósito del 50%.</li>
</ul>
<p>Para cotizarle, ¿nos comparte fecha, número de personas, tipo de evento, formato, horario y si además necesitan hospedaje? La capacidad y disponibilidad del espacio se confirman según la fecha, de forma independiente a la disponibilidad de habitaciones.</p>
<p>Quedamos atentos.</p>`,
      tags: ['evento', 'eventos', 'cóctel', 'celebración', 'cena privada', 'banquete', 'terraza', 'boda', 'event'],
    },
  },
  {
    dbName: 'Hotel Oculto',
    zona: 'Juárez',
    direccion: 'C. Versalles 80, Juárez, Cuauhtémoc, 06600 Ciudad de México, CDMX',
    totalHabitaciones: 21,
    inventario: [
      'Double City View — 3',
      'King City View — 7',
      'Signature King Studio — 2',
      'King Patio Studio — 2',
      'Double Patio Studio — 1',
      'Superior Double Studio — 1',
      'Signature Double Studio — 1',
      'King Jr. Suite — 3',
    ],
    minHabitacionesGrupo: 4,
    desayuno: null,
    restauranteBar: null,
    elevador: true,
    mascotas: 'aceptamos mascotas con un cargo de $800 MXN por estancia.',
    ninos: 'recibimos huéspedes a partir de los 16 años.',
    notasServicios: [
      'Estamos a pasos de Paseo de la Reforma, en una atmósfera tranquila y contemporánea.',
    ],
    eventos: {
      name: 'Eventos y celebraciones',
      description:
        'Cuando el cliente pregunta por organizar un evento, cóctel, celebración o reunión en el hotel.',
      body: `<p>¡Hola! Muchas gracias por pensar en Hotel Oculto para su evento.</p>
<p>Le comentamos que Hotel Oculto no cuenta con espacios para eventos. Sin embargo, dentro de la colección Vida Lenta tenemos dos propiedades ideales para lo que busca:</p>
<ul>
<li><strong>Hotel Dama</strong> (La Condesa): terraza para eventos en formato cóctel de hasta 40 personas, con menús de banquetes y de 3 tiempos.</li>
<li><strong>Hotel Parian</strong> (Roma Norte): terraza para eventos en formato cóctel de hasta 30 personas, dentro del histórico Pasaje Parián.</li>
</ul>
<p>Si le interesa, con gusto le cotizamos el evento en cualquiera de ellos; y si además necesita hospedaje, Hotel Oculto es el hotel más grande de la colección (21 habitaciones), a pasos de Paseo de la Reforma.</p>
<p>¿Nos comparte fecha, número de personas y tipo de evento para preparar la propuesta?</p>`,
      tags: ['evento', 'eventos', 'cóctel', 'celebración', 'reunión', 'event'],
    },
  },
  {
    dbName: 'Casa Levora',
    zona: 'Anzures',
    direccion: 'Leibnitz 190, Anzures, Miguel Hidalgo, 11590 Ciudad de México, CDMX',
    totalHabitaciones: 9,
    inventario: [
      'Courtyard Suite — 1',
      'Courtyard Studio — 1',
      'Urban Suite — 3',
      'Terrace Queen Studio — 1',
      'Levora Suite — 1',
      'Terrace Suite — 1',
      'Terrace King Studio — 1',
    ],
    minHabitacionesGrupo: 2,
    desayuno: 'desayuno continental servido en el desayunador (lobby)',
    restauranteBar: null,
    elevador: false,
    mascotas: 'aceptamos mascotas con un cargo de $800 MXN por estancia.',
    ninos: 'somos un hotel kids friendly. No contamos con camas extra.',
    notasServicios: [
      'Nuestras suites cuentan con cocina y terraza privada, ideales para estancias largas.',
      'No contamos con habitaciones dobles (dos camas).',
    ],
    eventos: {
      name: 'Eventos y celebraciones',
      description:
        'Cuando el cliente pregunta por organizar un evento, cóctel, celebración o reunión en el hotel.',
      body: `<p>¡Hola! Gracias por pensar en Casa Levora para su evento.</p>
<p>En Casa Levora podemos recibir eventos pequeños en formato cóctel para un máximo de <strong>20 personas</strong>, con dos condiciones importantes: se realizan únicamente al aire libre y exclusivamente para huéspedes de la casa, debido al tamaño del espacio y a la cercanía con las habitaciones. También organizamos cenas privadas, propuestas y celebraciones íntimas.</p>
<p>Si su evento es de mayor tamaño, dentro de la colección Vida Lenta podemos proponerle Hotel Dama (cóctel hasta 40 personas, en La Condesa) o Hotel Parian (cóctel hasta 30 personas, en Roma Norte).</p>
<p>Para confirmar un evento se requiere un depósito del 50%, y la disponibilidad del espacio se valida según la fecha. ¿Nos comparte fecha, número de personas, tipo de evento y si necesitan hospedaje en la casa?</p>
<p>Quedamos atentos.</p>`,
      tags: ['evento', 'eventos', 'cóctel', 'celebración', 'cena privada', 'event'],
    },
  },
  {
    dbName: 'Casa Bosques Pension',
    zona: 'Roma Norte',
    direccion: 'Córdoba 23A, Roma Norte, Cuauhtémoc, 06700 Ciudad de México, CDMX',
    totalHabitaciones: 10,
    inventario: ['Grand — 4', 'Signature — 3', 'Signature Terrace — 2', 'Petite — 1'],
    minHabitacionesGrupo: 2,
    desayuno: null,
    restauranteBar: 'sí; contamos con Ideal, nuestro espacio de alimentos y bebidas',
    elevador: false,
    mascotas: 'únicamente aceptamos animales de servicio.',
    ninos: 'recibimos huéspedes a partir de los 16 años.',
    notasServicios: [
      'Estamos ubicados sobre Casa Bosques Bookstore y Chocolate Atelier, una experiencia de barrio y comunidad creativa.',
      'No contamos con espacios comunes.',
    ],
    eventos: {
      name: 'Eventos y celebraciones',
      description:
        'Cuando el cliente pregunta por organizar un evento, cóctel, celebración, cena privada o reunión en el hotel.',
      body: `<p>¡Hola! Muchas gracias por pensar en Casa Bosques Pension para su evento.</p>
<p>Le comentamos que Casa Bosques Pension no cuenta con espacios para eventos. Lo que sí podemos ofrecer, sujeto a confirmación interna según la fecha, son cenas privadas con el menú de Ideal (nuestro espacio de alimentos y bebidas) y la renta total de la casa (buyout, 10 habitaciones).</p>
<p>Si busca un espacio de eventos con mayor capacidad, dentro de la colección Vida Lenta le podemos proponer:</p>
<ul>
<li><strong>Hotel Dama</strong> (La Condesa): terraza para eventos en formato cóctel de hasta 40 personas, con menús de banquetes y de 3 tiempos.</li>
<li><strong>Hotel Parian</strong> (Roma Norte): terraza para eventos en formato cóctel de hasta 30 personas, dentro del histórico Pasaje Parián.</li>
</ul>
<p>¿Nos comparte fecha, número de personas y tipo de evento para validar la mejor opción y prepararle una propuesta?</p>`,
      tags: ['evento', 'eventos', 'cóctel', 'celebración', 'cena privada', 'buyout', 'event'],
    },
  },
];

function buildTemplates(h: HotelData): TemplateSeed[] {
  return [
    cotizacionGrupo(h),
    disponibilidadTarifas(h),
    h.eventos,
    serviciosInfo(h),
    checkInOut(h),
    politicas(h),
    buyout(h),
    seguimiento(h),
  ];
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No DB connection');

  const tenantId = new mongoose.Types.ObjectId(TENANT_ID);
  const hotelsCol = db.collection('hotels');
  const templatesCol = db.collection('response_templates');

  const hotels = await hotelsCol.find({ tenantId }).toArray();
  if (hotels.length === 0) {
    console.log(`No hay hoteles para el tenant ${TENANT_ID}.`);
    await mongoose.disconnect();
    return;
  }

  let created = 0;
  let skipped = 0;
  const now = new Date();

  for (const data of HOTELES) {
    const hotel = hotels.find((hh) => hh.name === data.dbName);
    if (!hotel) {
      console.log(`⚠️  Hotel no encontrado en DB: "${data.dbName}" — se omite`);
      continue;
    }
    console.log(`\n─── ${hotel.name} (${hotel._id}) ───`);
    for (const tpl of buildTemplates(data)) {
      const exists = await templatesCol.findOne({
        tenantId,
        hotelId: hotel._id,
        name: tpl.name,
      });
      if (exists) {
        console.log(`  ℹ️  ya existe: "${tpl.name}"`);
        skipped++;
        continue;
      }
      await templatesCol.insertOne({
        tenantId,
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

  const legacy = hotels.find((hh) => hh.name === LEGACY_HOTEL_NAME);
  if (legacy) {
    console.log(`\nℹ️  Hotel legacy "${LEGACY_HOTEL_NAME}" excluido a propósito (sin templates).`);
  }

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`✅ Templates creados: ${created} | ya existentes: ${skipped}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Error en seed-vida-lenta-templates:', err);
  process.exit(1);
});
