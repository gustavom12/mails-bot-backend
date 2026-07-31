import { Controller, Get, Patch, Post, Param, Query, Body, BadRequestException, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ConversationsService } from './conversations.service';
import { ConversationStatesService } from '../conversation-states/conversation-states.service';
import { AiTriageService } from '../ai/ai-triage.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly statesService: ConversationStatesService,
    private readonly aiTriageService: AiTriageService,
  ) {}

  @Get()
  findAll(
    @CurrentUser() me: UserDocument,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('mailboxId') mailboxId?: string,
    @Query('hotelId') hotelId?: string,
    @Query('stateId') stateId?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('search') search?: string,
  ) {
    return this.conversationsService.findAll(me.tenantId.toString(), {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 30,
      mailboxId,
      hotelId,
      stateId,
      assignedTo,
      search,
    });
  }

  @Get('kanban')
  kanban(
    @CurrentUser() me: UserDocument,
    @Query('mailboxId') mailboxId?: string,
    @Query('hotelId') hotelId?: string,
  ) {
    return this.conversationsService.findForKanban(me.tenantId.toString(), { mailboxId, hotelId });
  }

  @Get('counts')
  counts(@CurrentUser() me: UserDocument) {
    return this.conversationsService.countByState(me.tenantId.toString());
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() me: UserDocument) {
    const count = await this.conversationsService.countUnread(me.tenantId.toString());
    return { count };
  }

  @Get(':id')
  findOne(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.conversationsService.findOne(me.tenantId.toString(), id);
  }

  @Get(':id/messages')
  getMessages(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.conversationsService.getMessages(me.tenantId.toString(), id);
  }

  @Get(':id/messages/:messageId/attachments/:attachmentId')
  async downloadAttachment(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Param('attachmentId') attachmentId: string,
    @Res() res: Response,
  ) {
    const { content, contentType, filename } = await this.conversationsService.downloadAttachment(
      me.tenantId.toString(),
      id,
      messageId,
      attachmentId,
    );
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(filename)}"`,
    );
    res.send(content);
  }

  @Patch(':id/state')
  async updateState(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('stateId') stateId: string,
  ) {
    const states = await this.statesService.findAll(me.tenantId.toString());
    const state = states.find((s) => (s._id as Types.ObjectId).toString() === stateId);
    if (!state) throw new NotFoundException('Estado no encontrado');

    return this.conversationsService.updateState(
      me.tenantId.toString(),
      id,
      stateId,
      state.name,
      me._id.toString(),
    );
  }

  @Patch(':id/read')
  markRead(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('unread') unread?: boolean,
  ) {
    // Sin body o unread=false → marca como leída; unread=true → como no leída
    return this.conversationsService.setUnread(me.tenantId.toString(), id, unread === true);
  }

  @Patch(':id/assign')
  assign(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('userId') userId: string | null,
  ) {
    return this.conversationsService.assign(me.tenantId.toString(), id, userId);
  }

  /**
   * Asigna (o reasigna) el hotel de una conversación. Si la conversación tiene un
   * mensaje inbound, dispara la sugerencia de IA con el contexto del hotel elegido.
   */
  @Patch(':id/hotel')
  async assignHotel(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('hotelId') hotelId: string,
  ) {
    if (!hotelId) throw new BadRequestException('El hotelId es obligatorio');
    const tenantId = me.tenantId.toString();

    const conversation = await this.conversationsService.assignHotel(tenantId, id, hotelId);

    const lastInbound = await this.conversationsService.getLastInboundMessage(tenantId, id);
    if (lastInbound) {
      void this.aiTriageService.processInbound(
        id,
        tenantId,
        (lastInbound._id as Types.ObjectId).toString(),
      );
    }

    return conversation;
  }

  @Post(':id/reply')
  async sendReply(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('body') body: string,
    @Body('cc') cc?: { address: string; name?: string }[],
    @Body('attachments')
    attachments?: { name: string; mimeType: string; content: string; size?: number }[],
  ) {
    if (!body?.trim()) throw new BadRequestException('El cuerpo del mensaje es obligatorio');

    if (attachments?.length) {
      for (const a of attachments) {
        if (!a?.name || !a?.mimeType || !a?.content) {
          throw new BadRequestException('Adjunto inválido: faltan datos (name, mimeType o content)');
        }
      }
      // Límite total aproximado de 25MB en base64 (~18MB de archivos reales).
      const totalBytes = attachments.reduce((acc, a) => acc + a.content.length, 0);
      if (totalBytes > 25 * 1024 * 1024) {
        throw new BadRequestException('Los adjuntos superan el tamaño máximo permitido (25MB).');
      }
    }

    return this.conversationsService.sendReply(
      me.tenantId.toString(),
      id,
      body,
      cc,
      me._id.toString(),
      attachments,
    );
  }

  /**
   * Regenera la sugerencia de respuesta IA para una conversación.
   * Usa el último mensaje inbound de la conversación como contexto.
   */
  @Post(':id/ai/suggest')
  async suggest(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    const tenantId = me.tenantId.toString();
    const lastInbound = await this.conversationsService.getLastInboundMessage(tenantId, id);
    if (!lastInbound) throw new NotFoundException('No se encontró mensaje inbound en esta conversación');

    await this.aiTriageService.processInbound(
      id,
      tenantId,
      (lastInbound._id as Types.ObjectId).toString(),
    );

    return this.conversationsService.findOne(tenantId, id);
  }
}
