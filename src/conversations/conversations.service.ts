import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from './schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { Mailbox, MailboxDocument } from '../mailboxes/schemas/mailbox.schema';
import { AurinkoService } from '../aurinko/aurinko.service';
import { EncryptionService } from '../common/crypto/encryption.service';

export interface ConversationFilters {
  mailboxId?: string;
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
    private readonly aurinkoService: AurinkoService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async findAll(tenantId: string, filters: ConversationFilters = {}) {
    const { mailboxId, stateId, assignedTo, search, page = 1, limit = 30 } = filters;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (mailboxId) query.mailboxId = new Types.ObjectId(mailboxId);
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
        .populate('stateId', 'name color isClosed')
        .populate('assignedTo', 'name email')
        .lean()
        .exec(),
      this.conversationModel.countDocuments(query),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  async findForKanban(tenantId: string, filters: { mailboxId?: string } = {}) {
    const query: Record<string, unknown> = { tenantId: new Types.ObjectId(tenantId) };
    if (filters.mailboxId) query.mailboxId = new Types.ObjectId(filters.mailboxId);

    const conversations = await this.conversationModel
      .find(query)
      .sort({ lastActivityAt: -1 })
      .populate('stateId', 'name color order isClosed')
      .populate('assignedTo', 'name email')
      .populate('mailboxId', 'email')
      .lean()
      .exec();

    return conversations;
  }

  async findOne(tenantId: string, conversationId: string): Promise<ConversationDocument> {
    const conversation = await this.conversationModel
      .findOne({ _id: new Types.ObjectId(conversationId), tenantId: new Types.ObjectId(tenantId) })
      .populate('mailboxId', 'email')
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
      attachments: [],
      approvedBy: null,
    });

    // Keep lastActivityAt up to date
    await this.conversationModel.updateOne(
      { _id: conversation._id },
      { $set: { lastActivityAt: new Date() } },
    );

    return result;
  }
}
