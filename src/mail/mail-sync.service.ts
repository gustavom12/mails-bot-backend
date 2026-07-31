import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from '../conversations/schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { Mailbox, MailboxDocument } from '../mailboxes/schemas/mailbox.schema';
import { MicrosoftService, GraphMessage } from '../microsoft/microsoft.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { ConversationStatesService } from '../conversation-states/conversation-states.service';

@Injectable()
export class MailSyncService {
  private readonly logger = new Logger(MailSyncService.name);

  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
    private readonly microsoftService: MicrosoftService,
    private readonly encryptionService: EncryptionService,
    private readonly statesService: ConversationStatesService,
  ) {}

  /**
   * Obtiene un access token válido para la casilla, renovándolo si está próximo a expirar.
   */
  async getValidAccessToken(mailbox: MailboxDocument): Promise<string> {
    if (!mailbox.accessToken || !mailbox.refreshToken) {
      throw new Error(`Casilla ${mailbox.email} no tiene tokens OAuth`);
    }

    const expiresAt = mailbox.tokenExpiresAt ? new Date(mailbox.tokenExpiresAt) : new Date(0);
    const needsRefresh = expiresAt.getTime() - Date.now() < 5 * 60 * 1000; // 5 min de margen

    if (needsRefresh) {
      this.logger.log(`Renovando token para ${mailbox.email}`);
      const decryptedRefresh = this.encryptionService.decrypt(mailbox.refreshToken);
      const tokens = await this.microsoftService.refreshAccessToken(decryptedRefresh);

      mailbox.accessToken = this.encryptionService.encrypt(tokens.accessToken);
      mailbox.refreshToken = this.encryptionService.encrypt(tokens.refreshToken);
      mailbox.tokenExpiresAt = tokens.expiresAt;
      mailbox.status = 'connected';
      await mailbox.save();
    }

    return this.encryptionService.decrypt(mailbox.accessToken);
  }

  /**
   * Sincroniza los últimos emails de una casilla y los persiste como conversaciones + mensajes.
   */
  async syncMailbox(
    mailboxId: string,
    tenantId?: string,
  ): Promise<{ synced: number; skipped: number }> {
    const query: Record<string, unknown> = { _id: new Types.ObjectId(mailboxId) };
    if (tenantId) query.tenantId = new Types.ObjectId(tenantId);

    const mailbox = await this.mailboxModel.findOne(query);
    if (!mailbox || mailbox.status !== 'connected') {
      throw new Error('Casilla no conectada');
    }

    const accessToken = await this.getValidAccessToken(mailbox);
    const messages = await this.microsoftService.getMessages(accessToken, 50);

    let synced = 0;
    let skipped = 0;

    for (const graphMsg of messages) {
      if (graphMsg.isDraft) { skipped++; continue; }

      const alreadyExists = await this.messageModel.findOne({
        graphMessageId: graphMsg.id,
      });
      if (alreadyExists) { skipped++; continue; }

      await this.upsertConversationAndMessage(mailbox, graphMsg);
      synced++;
    }

    return { synced, skipped };
  }

  private async upsertConversationAndMessage(
    mailbox: MailboxDocument,
    graphMsg: GraphMessage,
  ): Promise<void> {
    const tenantId = mailbox.tenantId;
    const mailboxId = mailbox._id as Types.ObjectId;

    // Buscar o crear la conversación por internetMessageId del primer mensaje del hilo
    let conversation = await this.conversationModel.findOne({
      graphConversationId: graphMsg.conversationId,
      tenantId,
    });

    if (!conversation) {
      // Buscar el estado por defecto del tenant (o el primero disponible)
      let defaultState = await this.statesService.findDefault(tenantId.toString());
      if (!defaultState) {
        await this.statesService.seedDefaults(tenantId.toString());
        defaultState = await this.statesService.findDefault(tenantId.toString());
      }

      conversation = await this.conversationModel.create({
        tenantId,
        mailboxId,
        // El hotel se asigna manualmente (una casilla puede servir a varios hoteles)
        hotelId: null,
        stateId: defaultState!._id,
        internetMessageId: graphMsg.internetMessageId,
        graphConversationId: graphMsg.conversationId,
        subject: graphMsg.subject ?? '(sin asunto)',
        assignedTo: null,
        lastActivityAt: new Date(graphMsg.receivedDateTime),
        contactEmail: graphMsg.from.emailAddress.address,
        contactName: graphMsg.from.emailAddress.name ?? null,
        statusHistory: [],
      });
    } else {
      // Actualizar última actividad si el mensaje es más nuevo
      const msgDate = new Date(graphMsg.receivedDateTime);
      if (msgDate > conversation.lastActivityAt) {
        conversation.lastActivityAt = msgDate;
        await conversation.save();
      }
    }

    const isOutbound = graphMsg.from.emailAddress.address.toLowerCase() === mailbox.email.toLowerCase();

    await this.messageModel.create({
      tenantId,
      conversationId: conversation._id,
      mailboxId,
      graphMessageId: graphMsg.id,
      internetMessageId: graphMsg.internetMessageId,
      subject: graphMsg.subject ?? '(sin asunto)',
      from: graphMsg.from.emailAddress,
      toRecipients: graphMsg.toRecipients.map((r) => r.emailAddress),
      ccRecipients: graphMsg.ccRecipients.map((r) => r.emailAddress),
      bodyHtml: graphMsg.body.content,
      bodyPreview: graphMsg.bodyPreview,
      direction: isOutbound ? 'outbound' : 'inbound',
      receivedAt: new Date(graphMsg.receivedDateTime),
      attachments: [],
      approvedBy: null,
    });
  }
}
