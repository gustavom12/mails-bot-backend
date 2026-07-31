import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { Mailbox, MailboxDocument } from '../mailboxes/schemas/mailbox.schema';
import { Hotel, HotelDocument } from '../hotels/schemas/hotel.schema';
import { AurinkoService } from '../aurinko/aurinko.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { ConversationStatesService } from '../conversation-states/conversation-states.service';

export interface ConversationFilters {
  mailboxId?: string;
  hotelId?: string;
  stateId?: string;
  assignedTo?: string;
  search?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class ConversationsService {
  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
    @InjectModel(Hotel.name) private readonly hotelModel: Model<HotelDocument>,
    private readonly aurinkoService: AurinkoService,
    private readonly encryptionService: EncryptionService,
    private readonly statesService: ConversationStatesService,
    private readonly config: ConfigService,
  ) {}

  async findAll(tenantId: string, filters: ConversationFilters = {}) {
    const { mailboxId, hotelId, stateId, assignedTo, search, page = 1, limit = 30 } = filters;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (mailboxId) query.mailboxId = new Types.ObjectId(mailboxId);
    if (hotelId) query.hotelId = new Types.ObjectId(hotelId);
    if (stateId) query.stateId = new Types.ObjectId(stateId);
    if (assignedTo) query.assignedTo = new Types.ObjectId(assignedTo);
    if (search) {
      query.$or = [
        { subject: { $regex: search, $options: 'i' } },
        { contactEmail: { $regex: search, $options: 'i' } },
        { contactName: { $regex: search, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.conversationModel
        .find(query)
        .sort({ lastActivityAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('mailboxId', 'email')
        .populate('hotelId', 'name')
        .populate('stateId', 'name color isClosed')
        .populate('assignedTo', 'name email')
        .lean()
        .exec(),
      this.conversationModel.countDocuments(query),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findForKanban(tenantId: string, filters: { mailboxId?: string; hotelId?: string } = {}) {
    const query: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (filters.mailboxId) query.mailboxId = new Types.ObjectId(filters.mailboxId);
    if (filters.hotelId) query.hotelId = new Types.ObjectId(filters.hotelId);

    const conversations = await this.conversationModel
      .find(query)
      .sort({ lastActivityAt: -1 })
      .populate('stateId', 'name color order isClosed')
      .populate('assignedTo', 'name email')
      .populate('mailboxId', 'email')
      .populate('hotelId', 'name')
      .lean()
      .exec();

    return conversations;
  }

  async findOne(tenantId: string, conversationId: string): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findOne({ _id: new Types.ObjectId(conversationId), tenantId: new Types.ObjectId(tenantId) })
      .populate('mailboxId', 'email')
      .populate('hotelId', 'name')
      .populate('stateId', 'name color isClosed')
      .populate('assignedTo', 'name email')
      .exec();

    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    return conversation;
  }

  async getMessages(tenantId: string, conversationId: string): Promise<MessageDocument[]> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');

    return this.messageModel
      .find({ conversationId: new Types.ObjectId(conversationId) })
      .sort({ receivedAt: 1 })
      .exec();
  }

  /**
   * Descarga un adjunto de un mensaje. Busca el mensaje del tenant, obtiene el
   * `attachmentId` del proveedor y recupera el binario desde Aurinko usando el
   * token de la casilla. No se almacena el archivo en la base.
   */
  async downloadAttachment(
    tenantId: string,
    conversationId: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ content: Buffer; contentType: string; filename: string }> {
    const message = await this.messageModel.findOne({
      _id: new Types.ObjectId(messageId),
      conversationId: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!message) throw new NotFoundException('Mensaje no encontrado');

    const attachment = message.attachments.find((a) => a.attachmentId === attachmentId);
    if (!attachment || !attachment.attachmentId) {
      throw new NotFoundException('Adjunto no encontrado');
    }

    const mailbox = await this.mailboxModel.findOne({
      _id: message.mailboxId,
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!mailbox?.accessToken) {
      throw new BadRequestException('La casilla no tiene token de acceso.');
    }

    const token = this.encryptionService.decrypt(mailbox.accessToken);
    const { content, contentType } = await this.aurinkoService.getAttachment(
      token,
      message.graphMessageId,
      attachment.attachmentId,
    );

    return {
      content,
      contentType: attachment.contentType || contentType,
      filename: attachment.name || 'adjunto',
    };
  }

  async updateState(
    tenantId: string,
    conversationId: string,
    stateId: string,
    stateName: string,
    userId: string,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');

    const historyEntry = {
      stateId: new Types.ObjectId(stateId),
      stateName,
      changedBy: new Types.ObjectId(userId),
      changedAt: new Date(),
    };

    conversation.stateId = new Types.ObjectId(stateId);
    conversation.statusHistory.push(historyEntry);
    return conversation.save();
  }

  async changeStateSystem(
    conversationId: string,
    stateId: string,
    stateName: string,
    note?: string,
  ): Promise<ConversationDocument | null> {
    const conversation = await this.conversationModel.findById(conversationId);
    if (!conversation) return null;

    const historyEntry = {
      stateId: new Types.ObjectId(stateId),
      stateName,
      changedBy: null,
      changedAt: new Date(),
      note: note ?? undefined,
    };

    conversation.stateId = new Types.ObjectId(stateId);
    conversation.statusHistory.push(historyEntry);
    return conversation.save();
  }

  async setUnread(
    tenantId: string,
    conversationId: string,
    unread: boolean,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(conversationId), tenantId: new Types.ObjectId(tenantId) },
        { unread },
        { new: true },
      )
      .populate('mailboxId', 'email')
      .populate('hotelId', 'name')
      .populate('stateId', 'name color isClosed')
      .populate('assignedTo', 'name email');

    if (!conversation) throw new NotFoundException('Conversación no encontrada');
    return conversation;
  }

  async countUnread(tenantId: string): Promise<number> {
    return this.conversationModel.countDocuments({
      tenantId: new Types.ObjectId(tenantId),
      unread: true,
    });
  }

  async assign(
    tenantId: string,
    conversationId: string,
    userId: string | null,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');

    conversation.assignedTo = userId ? new Types.ObjectId(userId) : null;
    return conversation.save();
  }

  /**
   * Asigna (o reasigna) el hotel de una conversación. Valida que el hotel
   * pertenezca a la misma casilla que la conversación.
   */
  async assignHotel(
    tenantId: string,
    conversationId: string,
    hotelId: string,
  ): Promise<ConversationDocument> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');

    const hotel = await this.hotelModel.findOne({
      _id: new Types.ObjectId(hotelId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!hotel) throw new NotFoundException('Hotel no encontrado');

    // El hotel debe pertenecer a la misma casilla que recibe la conversación.
    if (!hotel.mailboxId || hotel.mailboxId.toString() !== conversation.mailboxId.toString()) {
      throw new BadRequestException('El hotel no pertenece a la casilla de esta conversación');
    }

    conversation.hotelId = hotel._id as Types.ObjectId;
    await conversation.save();

    return this.findOne(tenantId, conversationId);
  }

  async countByState(tenantId: string): Promise<{ stateId: string; count: number }[]> {
    const result = await this.conversationModel.aggregate([
      { $match: { tenantId: new Types.ObjectId(tenantId) } },
      { $group: { _id: '$stateId', count: { $sum: 1 } } },
    ]);
    return result.map((r) => ({ stateId: r._id.toString(), count: r.count as number }));
  }

  async getLastInboundMessage(tenantId: string, conversationId: string): Promise<MessageDocument | null> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');

    return this.messageModel
      .findOne({ conversationId: new Types.ObjectId(conversationId), direction: 'inbound' })
      .sort({ receivedAt: -1 })
      .exec();
  }

  async sendReply(
    tenantId: string,
    conversationId: string,
    body: string,
    cc?: { address: string; name?: string }[],
    userId?: string,
    attachments?: { name: string; mimeType: string; content: string; size?: number }[],
  ): Promise<{ id: string }> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) throw new NotFoundException('Conversación no encontrada');

    const mailbox = await this.mailboxModel.findOne({
      _id: conversation.mailboxId,
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!mailbox) throw new NotFoundException('Casilla no encontrada');
    if (!mailbox.accessToken) {
      throw new BadRequestException('La casilla no tiene token de acceso. Conectala primero.');
    }
    if (mailbox.status !== 'connected') {
      throw new BadRequestException('La casilla no está conectada.');
    }

    const token = this.encryptionService.decrypt(mailbox.accessToken);
    const subject = conversation.subject.toLowerCase().startsWith('re:')
      ? conversation.subject
      : `Re: ${conversation.subject}`;

    const result = await this.aurinkoService.sendEmail(token, {
      subject,
      body,
      to: [{ address: conversation.contactEmail, name: conversation.contactName ?? undefined }],
      ...(cc?.length ? { cc } : {}),
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              name: a.name,
              mimeType: a.mimeType,
              content: a.content,
            })),
          }
        : {}),
    });

    // Aurinko may not always return an id — generate a stable fallback
    const messageId = result.id || `sent-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Persist the outbound message immediately so it appears in the thread
    const bodyPreview = body.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim().slice(0, 300);
    await this.messageModel.create({
      tenantId: new Types.ObjectId(tenantId),
      conversationId: new Types.ObjectId(conversationId),
      mailboxId: mailbox._id,
      graphMessageId: messageId,
      internetMessageId: messageId,
      subject,
      from: { address: mailbox.email, name: mailbox.email },
      toRecipients: [{ address: conversation.contactEmail, name: conversation.contactName ?? '' }],
      ccRecipients: cc?.map((c) => ({ address: c.address, name: c.name ?? '' })) ?? [],
      bodyHtml: body,
      bodyPreview,
      direction: 'outbound' as const,
      receivedAt: new Date(),
      attachments:
        attachments?.map((a) => ({
          name: a.name,
          contentType: a.mimeType,
          s3Key: '',
          size: a.size ?? Math.floor((a.content.length * 3) / 4),
        })) ?? [],
      approvedBy: null,
    });

    // Keep lastActivityAt up to date, marcar como leída (el admin ya la atendió)
    // y registrar que el último mensaje ahora es saliente (esperando al cliente).
    const setFields: Record<string, unknown> = {
      lastActivityAt: new Date(),
      unread: false,
      lastMessageDirection: 'outbound',
    };
    const update: Record<string, unknown> = { $set: setFields };

    // Al responder, la conversación pasa al estado "esperando respuesta del cliente".
    const targetStateName =
      this.config.get<string>('FOLLOWUP_STATE_NAME') ?? 'Esperando respuesta cliente';
    const states = await this.statesService.findAll(tenantId);
    const targetState = states.find((s) => s.name === targetStateName);

    if (
      targetState &&
      conversation.stateId.toString() !== (targetState._id as Types.ObjectId).toString()
    ) {
      setFields.stateId = targetState._id;
      update.$push = {
        statusHistory: {
          stateId: targetState._id,
          stateName: targetState.name,
          changedBy: userId ? new Types.ObjectId(userId) : null,
          changedAt: new Date(),
          note: 'auto: respuesta enviada al cliente',
        },
      };
    }

    await this.conversationModel.updateOne({ _id: conversation._id }, update);

    return result;
  }
}
