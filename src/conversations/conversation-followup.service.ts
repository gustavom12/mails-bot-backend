import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import {
  ConversationState,
  ConversationStateDocument,
} from '../conversation-states/schemas/conversation-state.schema';
import { ConversationsService } from './conversations.service';
import { AiTriageService } from '../ai/ai-triage.service';

@Injectable()
export class ConversationFollowupService {
  private readonly logger = new Logger(ConversationFollowupService.name);
  private isRunning = false;

  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(ConversationState.name)
    private readonly stateModel: Model<ConversationStateDocument>,
    private readonly conversationsService: ConversationsService,
    private readonly aiTriageService: AiTriageService,
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
    const attentionDays = Number(this.config.get<string>('ATTENTION_AFTER_DAYS') ?? '5');
    const attentionStateName =
      this.config.get<string>('ATTENTION_STATE_NAME') ?? 'Requiere atención';

    const now = new Date();
    const cutoff = new Date(now.getTime() - attentionDays * 24 * 60 * 60 * 1000);

    this.logger.log(
      `Followup cron iniciado — "${attentionStateName}" >= ${attentionDays}d (cutoff: ${cutoff.toISOString()})`,
    );

    // Cargar los estados "Requiere atención" activos y construir mapa por tenantId
    const attentionStates = await this.stateModel
      .find({ active: true, name: attentionStateName })
      .lean()
      .exec();

    const attentionStateByTenant = new Map<string, ConversationStateDocument>();
    for (const state of attentionStates) {
      const tid = state.tenantId.toString();
      if (!attentionStateByTenant.has(tid)) {
        attentionStateByTenant.set(tid, state as unknown as ConversationStateDocument);
      }
    }

    // Buscar conversaciones cuyo lastActivityAt superó el umbral de inactividad
    const candidates = await this.conversationModel
      .find({ lastActivityAt: { $lt: cutoff } })
      .select('_id tenantId hotelId stateId lastActivityAt')
      .lean()
      .exec();

    this.logger.log(`Conversaciones candidatas: ${candidates.length}`);

    let updated = 0;
    let drafts = 0;
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

      const attentionState = attentionStateByTenant.get(tenantId);
      if (!attentionState) {
        this.logger.warn(
          `Tenant ${tenantId} sin estado "${attentionStateName}" — saltando conv ${conversationId}`,
        );
        skipped++;
        continue;
      }

      const attentionId = (attentionState._id as Types.ObjectId).toString();
      const currentStateId = (conv.stateId as Types.ObjectId).toString();
      if (currentStateId === attentionId) {
        skipped++;
        continue;
      }

      const ageDays =
        (now.getTime() - new Date(conv.lastActivityAt).getTime()) / (24 * 60 * 60 * 1000);
      await this.conversationsService.changeStateSystem(
        conversationId,
        attentionId,
        attentionState.name,
        'auto: sin respuesta del cliente',
      );
      updated++;

      // Preparar draft de seguimiento (templates) sin enviar el mail
      if (conv.hotelId) {
        await this.aiTriageService.prepareFollowupDraft(conversationId, tenantId);
        drafts++;
      }

      this.logger.debug(
        `Conv ${conversationId} marcada como "${attentionStateName}" (${ageDays.toFixed(1)}d sin respuesta)`,
      );
    }

    this.logger.log(
      `Followup cron completado — "${attentionStateName}": ${updated}, drafts: ${drafts}, saltadas: ${skipped}`,
    );
  }
}
