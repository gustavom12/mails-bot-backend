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

  /**
   * Resumen operativo del dashboard: solo conteos determinísticos + cola prioritaria.
   * No calcula tasas, promedios ni métricas interpretativas.
   *
   * `scopeHotelIds`: hoteles visibles para el usuario (null = sin restricción, owner).
   * Con scope, las conversaciones sin hotel quedan fuera (el admin no puede actuar sobre ellas).
   */
  async getDashboardSummary(tenantId: string, scopeHotelIds: Types.ObjectId[] | null = null) {
    const tenantOid = new Types.ObjectId(tenantId);
    const base: Record<string, unknown> = { tenantId: tenantOid };
    if (scopeHotelIds) base.hotelId = { $in: scopeHotelIds };

    const states = await this.statesService.findAll(tenantId);
    const waitingStateName =
      this.config.get<string>('FOLLOWUP_STATE_NAME') ?? 'Esperando respuesta cliente';
    const attentionStateName =
      this.config.get<string>('ATTENTION_STATE_NAME') ?? 'Requiere atención';

    const waitingState = states.find((s) => s.name === waitingStateName);
    const attentionState = states.find((s) => s.name === attentionStateName);
    const closedStateIds = states.filter((s) => s.isClosed).map((s) => s._id as Types.ObjectId);

    const waitingQuery = waitingState
      ? { ...base, stateId: waitingState._id }
      : { ...base, lastMessageDirection: 'outbound' as const };

    const attentionQuery = attentionState
      ? { ...base, stateId: attentionState._id }
      : { ...base, _id: { $exists: false } }; // 0 si el estado no existe

    const needsReplyQuery: Record<string, unknown> = {
      ...base,
      lastMessageDirection: 'inbound',
    };
    if (closedStateIds.length > 0) {
      needsReplyQuery.stateId = { $nin: closedStateIds };
    }

    const priorityOr: Record<string, unknown>[] = [
      { unread: true },
      { lastMessageDirection: 'inbound' },
    ];
    if (!scopeHotelIds) priorityOr.push({ hotelId: null });
    if (attentionState) {
      priorityOr.push({ stateId: attentionState._id });
    }

    const priorityQuery: Record<string, unknown> = {
      ...base,
      $or: priorityOr,
    };
    if (closedStateIds.length > 0) {
      priorityQuery.stateId = { $nin: closedStateIds };
    }

    const [unread, withoutHotel, waitingForClient, requiresAttention, needsReply, byStateRaw, priority] =
      await Promise.all([
        this.conversationModel.countDocuments({ ...base, unread: true }),
        scopeHotelIds
          ? Promise.resolve(0)
          : this.conversationModel.countDocuments({
              tenantId: tenantOid,
              hotelId: null,
              // Cerradas o internas ya no bloquean el triage ni requieren asignación.
              ...(closedStateIds.length > 0 ? { stateId: { $nin: closedStateIds } } : {}),
            }),
        this.conversationModel.countDocuments(waitingQuery),
        this.conversationModel.countDocuments(attentionQuery),
        this.conversationModel.countDocuments(needsReplyQuery),
        this.conversationModel.aggregate([
          { $match: base },
          { $group: { _id: '$stateId', count: { $sum: 1 } } },
        ]),
        this.conversationModel
          .find(priorityQuery)
          .sort({ unread: -1, lastActivityAt: -1 })
          .limit(8)
          .populate('mailboxId', 'email')
          .populate('hotelId', 'name')
          .populate('stateId', 'name color isClosed')
          .populate('assignedTo', 'name email')
          .lean()
          .exec(),
      ]);

    const countByStateId = new Map<string, number>(
      byStateRaw.map((r) => [r._id?.toString() ?? '', r.count as number]),
    );

    const byState = states
      .filter((s) => s.active)
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        stateId: (s._id as Types.ObjectId).toString(),
        name: s.name,
        color: s.color,
        count: countByStateId.get((s._id as Types.ObjectId).toString()) ?? 0,
        isClosed: s.isClosed,
      }));

    return {
      unread,
      withoutHotel,
      waitingForClient,
      requiresAttention,
      needsReply,
      byState,
      priority,
    };
  }

  /**
   * Estadísticas del dashboard: volumen diario, tiempo de primera respuesta,
   * conversaciones envejecidas y desglose por hotel y por casilla.
   *
   * `scopeHotelIds`: hoteles visibles para el usuario (null = sin restricción, owner).
   * Fechas agrupadas en UTC.
   */
  async getStats(
    tenantId: string,
    opts: {
      days: number;
      hotelId?: string;
      mailboxId?: string;
      scopeHotelIds?: Types.ObjectId[] | null;
    },
  ) {
    const tenantOid = new Types.ObjectId(tenantId);
    const { days, hotelId, mailboxId, scopeHotelIds = null } = opts;

    const from = new Date();
    from.setUTCHours(0, 0, 0, 0);
    from.setUTCDate(from.getUTCDate() - (days - 1));

    // Restricción efectiva de hoteles: intersección entre el scope del usuario
    // y el filtro pedido. Un hotelId fuera del scope produce resultados vacíos.
    let hotelRestriction: Types.ObjectId[] | null = scopeHotelIds;
    if (hotelId) {
      const requested = new Types.ObjectId(hotelId);
      hotelRestriction = scopeHotelIds
        ? scopeHotelIds.filter((h) => h.equals(requested))
        : [requested];
    }
    const mailboxOid = mailboxId ? new Types.ObjectId(mailboxId) : null;

    const states = await this.statesService.findAll(tenantId);
    const closedStateIds = states.filter((s) => s.isClosed).map((s) => s._id as Types.ObjectId);

    // --- Volumen diario (mensajes recibidos vs. enviados) ---
    const volumeMatch: Record<string, unknown> = { tenantId: tenantOid, receivedAt: { $gte: from } };
    if (mailboxOid) volumeMatch.mailboxId = mailboxOid;

    const volumePipeline: Record<string, unknown>[] = [{ $match: volumeMatch }];
    if (hotelRestriction) {
      volumePipeline.push(
        { $lookup: { from: 'conversations', localField: 'conversationId', foreignField: '_id', as: 'conv' } },
        { $unwind: '$conv' },
        { $match: { 'conv.hotelId': { $in: hotelRestriction } } },
      );
    }
    volumePipeline.push({
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } },
          direction: '$direction',
        },
        count: { $sum: 1 },
      },
    });

    // --- Primera respuesta: primer outbound - primer inbound por conversación ---
    const frMatch: Record<string, unknown> = { tenantId: tenantOid, createdAt: { $gte: from } };
    if (hotelRestriction) frMatch.hotelId = { $in: hotelRestriction };
    if (mailboxOid) frMatch.mailboxId = mailboxOid;

    const firstResponsePipeline: Record<string, unknown>[] = [
      { $match: frMatch },
      {
        $lookup: {
          from: 'messages',
          let: { cid: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$conversationId', '$$cid'] } } },
            { $group: { _id: '$direction', first: { $min: '$receivedAt' } } },
          ],
          as: 'firsts',
        },
      },
      { $project: { hotelId: 1, firsts: 1 } },
    ];

    // --- Envejecidas: pendientes de responder, sin actividad hace 24/48 h ---
    const now = Date.now();
    const agedBase: Record<string, unknown> = {
      tenantId: tenantOid,
      lastMessageDirection: 'inbound',
    };
    if (hotelRestriction) agedBase.hotelId = { $in: hotelRestriction };
    if (mailboxOid) agedBase.mailboxId = mailboxOid;
    if (closedStateIds.length > 0) agedBase.stateId = { $nin: closedStateIds };

    // --- Desglose por hotel y por casilla ---
    const notClosed =
      closedStateIds.length > 0 ? { $not: [{ $in: ['$stateId', closedStateIds] }] } : { $literal: true };
    const needsReplyCond = { $and: [{ $eq: ['$lastMessageDirection', 'inbound'] }, notClosed] };
    const cutoff24 = new Date(now - 24 * 60 * 60 * 1000);
    const groupCounters = {
      open: { $sum: { $cond: [notClosed, 1, 0] } },
      needsReply: { $sum: { $cond: [needsReplyCond, 1, 0] } },
      unread: { $sum: { $cond: ['$unread', 1, 0] } },
      aged24h: {
        $sum: { $cond: [{ $and: [needsReplyCond, { $lt: ['$lastActivityAt', cutoff24] }] }, 1, 0] },
      },
    };

    const byHotelMatch: Record<string, unknown> = {
      tenantId: tenantOid,
      hotelId: hotelRestriction ? { $in: hotelRestriction } : { $ne: null },
    };
    if (mailboxOid) byHotelMatch.mailboxId = mailboxOid;

    const byMailboxMatch: Record<string, unknown> = { tenantId: tenantOid };
    if (hotelRestriction) byMailboxMatch.hotelId = { $in: hotelRestriction };
    if (mailboxOid) byMailboxMatch.mailboxId = mailboxOid;

    const [volumeRaw, firstResponseRaw, aged24Count, aged48Count, byHotelRaw, byMailboxRaw, hotels, mailboxes] =
      await Promise.all([
        this.messageModel.aggregate(volumePipeline as never[]),
        this.conversationModel.aggregate(firstResponsePipeline as never[]),
        this.conversationModel.countDocuments({ ...agedBase, lastActivityAt: { $lt: cutoff24 } }),
        this.conversationModel.countDocuments({
          ...agedBase,
          lastActivityAt: { $lt: new Date(now - 48 * 60 * 60 * 1000) },
        }),
        this.conversationModel.aggregate([
          { $match: byHotelMatch },
          { $group: { _id: '$hotelId', ...groupCounters } },
        ] as never[]),
        this.conversationModel.aggregate([
          { $match: byMailboxMatch },
          { $group: { _id: '$mailboxId', ...groupCounters } },
        ] as never[]),
        this.hotelModel.find({ tenantId: tenantOid }).select('name').lean().exec(),
        this.mailboxModel.find({ tenantId: tenantOid }).select('email').lean().exec(),
      ]);

    // Serie diaria con días vacíos en cero
    const volumeByKey = new Map<string, number>(
      volumeRaw.map((r) => [`${r._id.date}|${r._id.direction}`, r.count as number]),
    );
    const volume: { date: string; inbound: number; outbound: number }[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      volume.push({
        date: key,
        inbound: volumeByKey.get(`${key}|inbound`) ?? 0,
        outbound: volumeByKey.get(`${key}|outbound`) ?? 0,
      });
    }

    // Tiempos de primera respuesta (en minutos)
    const diffs: { hotelId: string | null; minutes: number }[] = [];
    for (const row of firstResponseRaw as {
      hotelId: Types.ObjectId | null;
      firsts: { _id: string; first: Date }[];
    }[]) {
      const firstInbound = row.firsts.find((f) => f._id === 'inbound')?.first;
      const firstOutbound = row.firsts.find((f) => f._id === 'outbound')?.first;
      if (!firstInbound || !firstOutbound) continue;
      const ms = new Date(firstOutbound).getTime() - new Date(firstInbound).getTime();
      if (ms <= 0) continue;
      diffs.push({ hotelId: row.hotelId?.toString() ?? null, minutes: ms / 60000 });
    }

    const minutesList = diffs.map((d) => d.minutes).sort((a, b) => a - b);
    const median = (list: number[]): number | null => {
      if (list.length === 0) return null;
      const mid = Math.floor(list.length / 2);
      return list.length % 2 === 0 ? (list[mid - 1] + list[mid]) / 2 : list[mid];
    };
    const firstResponse = {
      count: minutesList.length,
      avgMinutes:
        minutesList.length > 0
          ? Math.round(minutesList.reduce((a, b) => a + b, 0) / minutesList.length)
          : null,
      medianMinutes: minutesList.length > 0 ? Math.round(median(minutesList) as number) : null,
      buckets: {
        under1h: minutesList.filter((m) => m < 60).length,
        from1to4h: minutesList.filter((m) => m >= 60 && m < 240).length,
        from4to24h: minutesList.filter((m) => m >= 240 && m < 1440).length,
        over24h: minutesList.filter((m) => m >= 1440).length,
      },
    };

    // Promedio de primera respuesta por hotel
    const tfrByHotel = new Map<string, number[]>();
    for (const d of diffs) {
      if (!d.hotelId) continue;
      const list = tfrByHotel.get(d.hotelId) ?? [];
      list.push(d.minutes);
      tfrByHotel.set(d.hotelId, list);
    }

    const hotelNames = new Map(hotels.map((h) => [(h._id as Types.ObjectId).toString(), h.name]));
    const byHotel = byHotelRaw
      .map((r) => {
        const id = r._id?.toString() ?? '';
        const tfrs = tfrByHotel.get(id);
        return {
          hotelId: id,
          name: hotelNames.get(id) ?? '—',
          open: r.open as number,
          needsReply: r.needsReply as number,
          unread: r.unread as number,
          aged24h: r.aged24h as number,
          avgFirstResponseMinutes:
            tfrs && tfrs.length > 0 ? Math.round(tfrs.reduce((a, b) => a + b, 0) / tfrs.length) : null,
        };
      })
      .sort((a, b) => b.needsReply - a.needsReply || b.open - a.open);

    const mailboxEmails = new Map(mailboxes.map((m) => [(m._id as Types.ObjectId).toString(), m.email]));
    const byMailbox = byMailboxRaw
      .map((r) => ({
        mailboxId: r._id?.toString() ?? '',
        email: mailboxEmails.get(r._id?.toString() ?? '') ?? '—',
        open: r.open as number,
        needsReply: r.needsReply as number,
        unread: r.unread as number,
        aged24h: r.aged24h as number,
      }))
      .sort((a, b) => b.needsReply - a.needsReply || b.open - a.open);

    return {
      days,
      from: from.toISOString(),
      volume,
      firstResponse,
      aging: { over24h: aged24Count, over48h: aged48Count },
      byHotel,
      byMailbox,
    };
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
