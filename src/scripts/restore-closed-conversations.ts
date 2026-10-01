/**
 * Devuelve a su estado cerrado las conversaciones que el cron de seguimiento
 * sacó de ahí.
 *
 * EL PROBLEMA
 * El cron movía a "Requiere atención" toda conversación con último mensaje
 * saliente y más de ATTENTION_AFTER_DAYS sin actividad, sin mirar si estaba
 * cerrada. Cuando alguien cerraba a mano una conversación vieja, la corrida
 * siguiente (como mucho una hora después) la reabría. El cron ya no toca los
 * estados cerrados; este script repara las que quedaron mal.
 *
 * QUÉ RESTAURA
 * Solo las conversaciones donde la reapertura fue, sin dudas, obra del cron:
 *   · están hoy en "Requiere atención"
 *   · el último movimiento del historial es del cron ("auto: sin respuesta del cliente")
 *   · el movimiento anterior es de una persona, hacia un estado cerrado
 *   · no entró ningún mail del cliente después de ese cierre
 * Vuelven al estado cerrado que eligió la persona, con una entrada en
 * `statusHistory` (`changedBy: null`) que deja registrado el arreglo.
 *
 * QUÉ NO TOCA
 * Las que alguien movió después del cron, y las que recibieron un mail nuevo del
 * cliente tras el cierre: ahí "Requiere atención" puede ser lo correcto.
 *
 * Correr DESPUÉS de desplegar el arreglo del cron: con la versión vieja en
 * producción, la corrida siguiente las vuelve a reabrir.
 *
 * DRY-RUN por defecto: muestra el impacto sin escribir nada.
 *
 * Uso:
 *   npm run conversations:restore-closed -- [--tenant <id>] [--limit <n>] [--apply]
 *
 * Variables de entorno: MONGODB_URI, ATTENTION_STATE_NAME (default "Requiere atención").
 */
import * as mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/mails-bot';
const ATTENTION_STATE_NAME = process.env.ATTENTION_STATE_NAME ?? 'Requiere atención';
/** Nota que deja el cron de seguimiento al mover una conversación. */
const CRON_NOTE = 'auto: sin respuesta del cliente';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface StateDoc {
  _id: mongoose.Types.ObjectId;
  tenantId: mongoose.Types.ObjectId;
  name: string;
  isClosed?: boolean;
}

interface HistoryEntry {
  stateId: mongoose.Types.ObjectId;
  stateName: string;
  changedBy: mongoose.Types.ObjectId | null;
  changedAt: Date;
  note?: string | null;
}

async function main() {
  const tenantFilter = arg('tenant');
  const detailLimit = Number(arg('limit') ?? '30');
  const apply = process.argv.includes('--apply');

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No se pudo obtener la conexión a la base de datos');

  const stateQuery: Record<string, unknown> = {};
  if (tenantFilter) stateQuery.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  const states = (await db
    .collection('conversation_states')
    .find(stateQuery)
    .toArray()) as unknown as StateDoc[];

  const closedById = new Map(states.filter((s) => s.isClosed).map((s) => [String(s._id), s]));
  const attentionIds = states.filter((s) => s.name === ATTENTION_STATE_NAME).map((s) => s._id);

  const convQuery: Record<string, unknown> = {
    stateId: { $in: attentionIds },
    'statusHistory.note': CRON_NOTE,
  };
  if (tenantFilter) convQuery.tenantId = new mongoose.Types.ObjectId(tenantFilter);
  const conversations = await db.collection('conversations').find(convQuery).toArray();

  let notLastMove = 0;
  let notManualClose = 0;
  let clientWroteBack = 0;
  const detail: string[] = [];
  const ops: { id: mongoose.Types.ObjectId; state: StateDoc }[] = [];

  for (const conv of conversations) {
    const history = (conv.statusHistory ?? []) as HistoryEntry[];
    const last = history[history.length - 1];
    const previous = history[history.length - 2];

    if (!last || last.changedBy || last.note !== CRON_NOTE) {
      notLastMove++;
      continue;
    }

    const closedState = previous?.changedBy ? closedById.get(String(previous.stateId)) : undefined;
    if (!previous || !closedState) {
      notManualClose++;
      continue;
    }

    const inboundAfterClose = await db.collection('messages').countDocuments({
      conversationId: conv._id,
      direction: 'inbound',
      receivedAt: { $gt: previous.changedAt },
    });
    if (inboundAfterClose > 0) {
      clientWroteBack++;
      continue;
    }

    ops.push({ id: conv._id, state: closedState });
    if (detail.length < detailLimit) {
      detail.push(
        `  → "${closedState.name}"  [${String(conv.subject ?? '(sin asunto)').slice(0, 55)}] ` +
          `cerrada ${new Date(previous.changedAt).toISOString().slice(0, 16)}, ` +
          `reabierta ${new Date(last.changedAt).toISOString().slice(0, 16)}`,
      );
    }
  }

  console.log(
    `\n📦 ${conversations.length} conversación(es) en "${ATTENTION_STATE_NAME}" movidas alguna vez por el cron\n`,
  );
  console.log(`─── A restaurar ───────────────────────────────`);
  console.log(`  cerradas a mano y reabiertas por el cron:       ${ops.length}`);
  console.log(`\n─── Sin cambios ───────────────────────────────`);
  console.log(`  alguien las movió después del cron:             ${notLastMove}`);
  console.log(`  no venían de un cierre manual:                  ${notManualClose}`);
  console.log(`  el cliente escribió después del cierre:         ${clientWroteBack}`);

  if (detail.length > 0) {
    console.log(`\n─── Detalle (primeras ${detail.length}) ──────────────────`);
    detail.forEach((d) => console.log(d));
  }

  if (!apply) {
    console.log(`\n🔍 DRY-RUN: no se modificó nada. Volvé a correr con --apply.\n`);
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const op of ops) {
    const res = await db.collection('conversations').updateOne(
      // Se vuelve a exigir el estado: si alguien la movió mientras corría el script, no se pisa.
      { _id: op.id, stateId: { $in: attentionIds } },
      {
        $set: { stateId: op.state._id },
        $push: {
          statusHistory: {
            stateId: op.state._id,
            stateName: op.state.name,
            changedBy: null,
            changedAt: new Date(),
            note: 'auto: se restaura el cierre manual que había reabierto el cron [script]',
          },
        } as never,
      },
    );
    written += res.modifiedCount;
  }
  console.log(`\n✅ ${written} conversación(es) restauradas\n`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Error:', err);
  process.exit(1);
});
