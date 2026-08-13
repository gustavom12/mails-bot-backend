import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from '../conversations/schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { Mailbox, MailboxDocument } from '../mailboxes/schemas/mailbox.schema';
import { AurinkoService, AurinkoMessage } from './aurinko.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { ConversationStatesService } from '../conversation-states/conversation-states.service';
import { AiTriageService } from '../ai/ai-triage.service';

export interface SyncResult {
  synced: number;
  skipped: number;
  errors: number;
  mailbox: string;
}

@Injectable()
export class AurinkoSyncService {
  private readonly logger = new Logger(AurinkoSyncService.name);

  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
    private readonly aurinkoService: AurinkoService,
    private readonly encryptionService: EncryptionService,
    private readonly statesService: ConversationStatesService,
    private readonly aiTriageService: AiTriageService,
  ) {}

  /**
   * Decripta el access token almacenado en la casilla.
   */
  private getAccessToken(mailbox: MailboxDocument): string {
    if (!mailbox.accessToken) throw new Error(`Casilla ${mailbox.email} no tiene access token`);
    return this.encryptionService.decrypt(mailbox.accessToken);
  }

  /**
   * Mapea los adjuntos de un mensaje de Aurinko al formato persistido.
   * Guardamos el `attachmentId` del proveedor para poder descargarlos on-demand
   * (no almacenamos el binario en Mongo).
   */
  private mapAttachments(msg: AurinkoMessage) {
    return (msg.attachments ?? []).map((a) => ({
      name: a.name || 'adjunto',
      contentType: a.mimeType || 'application/octet-stream',
      s3Key: '',
      size: a.size ?? 0,
      attachmentId: a.id,
      inline: a.inline ?? false,
      contentId: a.contentId ?? null,
    }));
  }

  /**
   * Sincroniza un mensaje específico por su ID de Aurinko.
   * Usado por el webhook cuando llega un evento `created`.
   */
  async syncMessageById(
    mailboxId: string,
    tenantId: string,
    aurinkoMessageId: string,
  ): Promise<boolean> {
    const mailbox = await this.mailboxModel.findOne({
      _id: new Types.ObjectId(mailboxId),
      tenantId: new Types.ObjectId(tenantId),
      status: 'connected',
    });
    if (!mailbox) throw new Error('Casilla no encontrada o no conectada');

    const token = this.getAccessToken(mailbox);

    // Deduplicar antes de fetchar
    const exists = await this.messageModel.findOne({ graphMessageId: aurinkoMessageId });
    if (exists) return false;

    const msg = await this.aurinkoService.getMessageById(token, aurinkoMessageId);

    await this.statesService.seedDefaults(tenantId);
    const defaultState = await this.statesService.findDefault(tenantId);
    if (!defaultState) throw new Error('No se encontró estado por defecto para el tenant');

    const labels = msg.sysLabels ?? [];
    if (labels.includes('draft') || msg.isDraft) return false;

    const isOutbound = labels.includes('sent') && !labels.includes('inbox');

    let conversation = await this.conversationModel.findOne({
      graphConversationId: msg.threadId,
      tenantId: new Types.ObjectId(tenantId),
    });
    const isNewConversation = !conversation;

    if (!conversation) {
      if (isOutbound) return false;
      conversation = await this.conversationModel.create({
        tenantId: new Types.ObjectId(tenantId),
        mailboxId: mailbox._id,
        // El hotel se asigna manualmente (una casilla puede servir a varios hoteles)
        hotelId: null,
        stateId: defaultState._id,
        internetMessageId: msg.internetMessageId,
        graphConversationId: msg.threadId,
        subject: msg.subject || '(sin asunto)',
        assignedTo: null,
        lastActivityAt: new Date(msg.receivedAt ?? msg.sentAt ?? Date.now()),
        contactEmail: msg.from?.address ?? '',
        contactName: msg.from?.name ?? null,
        statusHistory: [],
        lastMessageDirection: 'inbound',
      });
    } else {
      const msgDate = new Date(msg.receivedAt ?? msg.sentAt ?? Date.now());
      if (msgDate >= conversation.lastActivityAt) {
        conversation.lastActivityAt = msgDate;
        conversation.lastMessageDirection = isOutbound ? 'outbound' : 'inbound';
      }
      // Nuevo mensaje del cliente → vuelve a marcarse como no leída
      if (!isOutbound) conversation.unread = true;
      await conversation.save();
    }

    const bodyRaw = msg.body ?? msg.bodySnippet ?? '';
    const bodyHtml = bodyRaw.includes('<') ? bodyRaw : bodyRaw.replace(/\n/g, '<br>');

    const newMessage = await this.messageModel.create({
      tenantId: new Types.ObjectId(tenantId),
      conversationId: conversation._id,
      mailboxId: mailbox._id,
      graphMessageId: msg.id,
      internetMessageId: msg.internetMessageId,
      subject: msg.subject || '(sin asunto)',
      from: { name: msg.from?.name ?? '', address: msg.from?.address ?? '' },
      toRecipients: (msg.to ?? []).map((r) => ({ name: r.name ?? '', address: r.address })),
      ccRecipients: (msg.cc ?? []).map((r) => ({ name: r.name ?? '', address: r.address })),
      bodyHtml,
      bodyPreview: msg.bodySnippet ?? '',
      direction: isOutbound ? 'outbound' : 'inbound',
      receivedAt: new Date(msg.receivedAt ?? msg.sentAt ?? Date.now()),
      attachments: this.mapAttachments(msg),
      approvedBy: null,
    });

    // Triage IA para inbound: primero decide si es un mail interno (transaccional,
    // promocional, spam) y lo manda a "Internos"; si no, sigue el flujo normal
    // (que requiere hotel asignado — sin hotel se procesa al asignarlo manualmente).
    if (!isOutbound) {
      void this.aiTriageService.triageInbound(
        (conversation._id as import('mongoose').Types.ObjectId).toString(),
        tenantId,
        (newMessage._id as import('mongoose').Types.ObjectId).toString(),
        { newConversation: isNewConversation },
      );
    }

    return true;
  }

  /**
   * Trae los mensajes de Aurinko usando paginación.
   *
   * Con `since`, descarta los mensajes anteriores a esa fecha y corta la
   * paginación apenas una página entera queda fuera del rango (Aurinko
   * devuelve los mensajes de más nuevo a más viejo). El filtro `q=after:` de
   * la API no es confiable según el proveedor, por eso se filtra acá.
   */
  private async fetchMessages(token: string, since: Date | null): Promise<AurinkoMessage[]> {
    const all: AurinkoMessage[] = [];
    let pageToken: string | undefined;

    do {
      const page = await this.aurinkoService.getMessages(token, pageToken, 50);
      if (!since) {
        all.push(...page.records);
      } else {
        const inRange = page.records.filter((m) => {
          const date = new Date(m.receivedAt ?? m.sentAt ?? m.date ?? 0);
          return date >= since;
        });
        all.push(...inRange);
        if (page.records.length > 0 && inRange.length === 0) break;
      }
      pageToken = page.nextPageToken;
    } while (pageToken);

    return all;
  }

  /**
   * Sincroniza los emails de una casilla:
   * - Crea/actualiza Conversations (una por threadId)
   * - Crea Messages (uno por email)
   * Solo los mensajes de inbox y sent (no drafts).
   *
   * `since`: solo mensajes desde esa fecha (null = historial completo).
   */
  async syncMailbox(
    mailboxId: string,
    tenantId: string,
    opts: { since?: Date | null } = {},
  ): Promise<SyncResult> {
    const since = opts.since ?? null;
    const mailbox = await this.mailboxModel.findOne({
      _id: new Types.ObjectId(mailboxId),
      tenantId: new Types.ObjectId(tenantId),
      status: 'connected',
    });

    if (!mailbox) throw new Error('Casilla no encontrada o no conectada');

    const token = this.getAccessToken(mailbox);
    const messages = await this.fetchMessages(token, since);

    this.logger.log(
      `Sync ${mailbox.email}: ${messages.length} mensajes${since ? ` desde ${since.toISOString()}` : ' (historial completo)'}`,
    );

    // Asegurar que el tenant tiene estados configurados
    await this.statesService.seedDefaults(tenantId);
    const defaultState = await this.statesService.findDefault(tenantId);
    if (!defaultState) throw new Error('No se encontró estado por defecto para el tenant');

    let synced = 0;
    let skipped = 0;
    let errors = 0;

    for (const msg of messages) {
      try {
        const labels = msg.sysLabels ?? [];

        // Ignorar borradores
        if (labels.includes('draft') || msg.isDraft) {
          skipped++;
          continue;
        }

        // Determinar dirección por sysLabels (inbox = inbound, sent = outbound).
        // No usar from.address porque self-emails tienen from == mailbox.
        const isOutbound = labels.includes('sent') && !labels.includes('inbox');
        const direction = isOutbound ? 'outbound' : 'inbound';

        // Deduplicar por graphMessageId (Aurinko id)
        const exists = await this.messageModel.findOne({ graphMessageId: msg.id });
        if (exists) { skipped++; continue; }

        // Buscar conversación por threadId
        let conversation = await this.conversationModel.findOne({
          graphConversationId: msg.threadId,
          tenantId: new Types.ObjectId(tenantId),
        });
        const isNewConversation = !conversation;

        if (!conversation) {
          // Solo crear conversación desde mensajes inbound
          if (isOutbound) { skipped++; continue; }

          conversation = await this.conversationModel.create({
            tenantId: new Types.ObjectId(tenantId),
            mailboxId: mailbox._id,
            // El hotel se asigna manualmente (una casilla puede servir a varios hoteles)
            hotelId: null,
            stateId: defaultState._id,
            internetMessageId: msg.internetMessageId,
            graphConversationId: msg.threadId,
            subject: msg.subject || '(sin asunto)',
            assignedTo: null,
            lastActivityAt: new Date(msg.receivedAt ?? msg.date ?? Date.now()),
            contactEmail: msg.from?.address ?? '',
            contactName: msg.from?.name ?? null,
            statusHistory: [],
            lastMessageDirection: 'inbound',
          });
        } else {
          // Actualizar lastActivityAt y dirección si el mensaje es más nuevo
          const msgDate = new Date(msg.receivedAt ?? msg.date ?? Date.now());
          if (msgDate >= conversation.lastActivityAt) {
            conversation.lastActivityAt = msgDate;
            conversation.lastMessageDirection = isOutbound ? 'outbound' : 'inbound';
          }
          // Nuevo mensaje del cliente → vuelve a marcarse como no leída
          if (!isOutbound) conversation.unread = true;
          await conversation.save();
        }

        // Crear mensaje
        const bodyRaw = msg.body ?? msg.bodySnippet ?? '';
        const bodyHtml = bodyRaw.includes('<') ? bodyRaw : bodyRaw.replace(/\n/g, '<br>');
        const receivedAt = new Date(msg.receivedAt ?? msg.sentAt ?? msg.date ?? Date.now());

        const createdMsg = await this.messageModel.create({
          tenantId: new Types.ObjectId(tenantId),
          conversationId: conversation._id,
          mailboxId: mailbox._id,
          graphMessageId: msg.id,
          internetMessageId: msg.internetMessageId,
          subject: msg.subject || '(sin asunto)',
          from: { name: msg.from?.name ?? '', address: msg.from?.address ?? '' },
          toRecipients: (msg.to ?? []).map((r) => ({ name: r.name ?? '', address: r.address })),
          ccRecipients: (msg.cc ?? []).map((r) => ({ name: r.name ?? '', address: r.address })),
          bodyHtml,
          bodyPreview: msg.bodySnippet ?? '',
          direction,
          receivedAt,
          attachments: this.mapAttachments(msg),
          approvedBy: null,
        });

        // Triage IA para inbound: primero decide si es un mail interno (transaccional,
        // promocional, spam) y lo manda a "Internos"; si no, sigue el flujo normal
        // (que requiere hotel asignado — sin hotel se procesa al asignarlo manualmente).
        if (!isOutbound) {
          void this.aiTriageService.triageInbound(
            (conversation._id as import('mongoose').Types.ObjectId).toString(),
            tenantId,
            (createdMsg._id as import('mongoose').Types.ObjectId).toString(),
            { newConversation: isNewConversation },
          );
        }

        synced++;
      } catch (err) {
        this.logger.error(`Error al procesar mensaje ${msg.id}:`, err);
        errors++;
      }
    }

    this.logger.log(`Sync ${mailbox.email} completado: synced=${synced} skipped=${skipped} errors=${errors}`);
    return { synced, skipped, errors, mailbox: mailbox.email };
  }
}
