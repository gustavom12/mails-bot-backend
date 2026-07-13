import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { ConversationState, ConversationStateDocument } from '../conversation-states/schemas/conversation-state.schema';
import { ConversationsService } from './conversations.service';

interface TenantStates {
  followupState: ConversationStateDocument | null;
  closedState: ConversationStateDocument | null;
}

@Injectable()
export class ConversationFollowupService {
  private readonly logger = new Logger(ConversationFollowupService.name);
  private isRunning = false;

  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(ConversationState.name) private readonly stateModel: Model<ConversationStateDocument>,
    private readonly conversationsService: ConversationsService,
    private readonly config: ConfigService,
  ) {}

  @Cron(process.env.FOLLOWUP_CRON ?? CronExpression.EVERY_HOUR)
  async handleFollowupCron(): Promise<void> {
    const enabled = this.config.get<string>('FOLLOWUP_ENABLED') !== 'false';
    if (!enabled) return;

    if (this.isRunning) {
      this.logger.warn('Followup cron ya en ejecucion — saltando corrida');
      return;
    }

    this.isRunning = true;
    try {
      await this.run();
    } finally {
      this.isRunning = false;
    }
  }

  private async run(): Promise<void> {
    const followupHours = Number(this.config.get<string>('FOLLOWUP_AFTER_HOURS') ?? '48');
    const closeHours = Number(this.config.get<string>('CLOSE_AFTER_HOURS') ?? '120');
    const followupStateName = this.config.get<string>('FOLLOWUP_STATE_NAME') ?? 'Esperando respuesta cliente';

    const now = new Date();
    const followupCutoff = new Date(now.getTime() - followupHours * 60 * 60 * 1000);
    const closeCutoff = new Date(now.getTime() - closeHours * 60 * 60 * 1000);

    this.logger.log(
      `Followup cron iniciado — followup >= ${followupHours}h (cutoff: ${followupCutoff.toISOString()}), cierre >= ${closeHours}h (cutoff: ${closeCutoff.toISOString()})`,
    );

    // Cargar todos los estados activos y construir mapa por tenantId
    const allStates = await this.stateModel.find({ active: true }).lean().exec();
    const statesByTenant = new Map<string, TenantStates>();
    const closedStateIds = new Set<string>();

    for (const state of allStates) {
      const tid = state.tenantId.toString();
      if (!statesByTenant.has(tid)) {
        statesByTenant.set(tid, { followupState: null, closedState: null });
      }
      const entry = statesByTenant.get(tid)!;

      if (state.isClosed) {
        closedStateIds.add((state._id as Types.ObjectId).toString());
        // Tomar el primer estado cerrado encontrado por tenant
        if (!entry.closedState) entry.closedState = state as unknown as ConversationStateDocument;
      }
      if (state.name === followupStateName) {
        entry.followupState = state as unknown as ConversationStateDocument;
      }
    }

    // Buscar conversaciones no cerradas cuyo lastActivityAt superó el umbral de followup
    const closedIdObjects = [...closedStateIds].map((id) => new Types.ObjectId(id));
    const candidates = await this.conversationModel
      .find({
        lastActivityAt: { $lt: followupCutoff },
        ...(closedIdObjects.length ? { stateId: { $nin: closedIdObjects } } : {}),
      })
      .select('_id tenantId stateId lastActivityAt')
      .lean()
      .exec();

    this.logger.log(`Conversaciones candidatas: ${candidates.length}`);

    let followuped = 0;
    let closed = 0;
    let skipped = 0;

    for (const conv of candidates) {
      const tenantId = conv.tenantId.toString();
      const conversationId = (conv._id as Types.ObjectId).toString();

      // Verificar que el ultimo mensaje sea outbound (cliente no respondio)
      const lastMessage = await this.messageModel
        .findOne({ conversationId: conv._id })
        .sort({ receivedAt: -1 })
        .select('direction')
        .lean()
        .exec();

      if (!lastMessage || lastMessage.direction !== 'outbound') {
        skipped++;
        continue;
      }

      const tenantStates = statesByTenant.get(tenantId);
      if (!tenantStates) {
        this.logger.warn(`Tenant ${tenantId} sin estados configurados — saltando conv ${conversationId}`);
        skipped++;
        continue;
      }

      const currentStateId = (conv.stateId as Types.ObjectId).toString();
      const age = now.getTime() - new Date(conv.lastActivityAt).getTime();
      const ageHours = age / (60 * 60 * 1000);

      if (ageHours >= closeHours) {
        // Debe cerrarse
        const { closedState } = tenantStates;
        if (!closedState) {
          this.logger.warn(`Tenant ${tenantId} sin estado cerrado — saltando conv ${conversationId}`);
          skipped++;
          continue;
        }
        const closedId = (closedState._id as Types.ObjectId).toString();
        if (currentStateId === closedId) {
          skipped++;
          continue;
        }
        await this.conversationsService.changeStateSystem(
          conversationId,
          closedId,
          closedState.name,
          'auto: cierre por inactividad del cliente',
        );
        closed++;
        this.logger.debug(`Conv ${conversationId} cerrada (${ageHours.toFixed(1)}h sin respuesta)`);
      } else {
        // Debe pasar a seguimiento
        const { followupState } = tenantStates;
        if (!followupState) {
          this.logger.warn(
            `Tenant ${tenantId} sin estado "${followupStateName}" — saltando conv ${conversationId}`,
          );
          skipped++;
          continue;
        }
        const followupId = (followupState._id as Types.ObjectId).toString();
        if (currentStateId === followupId) {
          skipped++;
          continue;
        }
        await this.conversationsService.changeStateSystem(
          conversationId,
          followupId,
          followupState.name,
          'auto: sin respuesta del cliente',
        );
        followuped++;
        this.logger.debug(`Conv ${conversationId} marcada en seguimiento (${ageHours.toFixed(1)}h sin respuesta)`);
      }
    }

    this.logger.log(
      `Followup cron completado — seguimiento: ${followuped}, cerradas: ${closed}, saltadas: ${skipped}`,
    );
  }
}
