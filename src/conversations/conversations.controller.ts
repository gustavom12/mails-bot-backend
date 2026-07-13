import { Controller, Get, Patch, Post, Param, Query, Body, BadRequestException } from '@nestjs/common';
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
    @Query('stateId') stateId?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('search') search?: string,
  ) {
    return this.conversationsService.findAll(me.tenantId.toString(), {
      page: page ? parseInt(page) : 1,
      limit: limit ? parseInt(limit) : 30,
      mailboxId,
      stateId,
      assignedTo,
      search,
    });
  }

  @Get('kanban')
  kanban(@CurrentUser() me: UserDocument, @Query('mailboxId') mailboxId?: string) {
    return this.conversationsService.findForKanban(me.tenantId.toString(), { mailboxId });
  }

  @Get('counts')
  counts(@CurrentUser() me: UserDocument) {
    return this.conversationsService.countByState(me.tenantId.toString());
  }

  @Get(':id')
  findOne(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.conversationsService.findOne(me.tenantId.toString(), id);
  }

  @Get(':id/messages')
  getMessages(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.conversationsService.getMessages(me.tenantId.toString(), id);
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

  @Patch(':id/assign')
  assign(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('userId') userId: string | null,
  ) {
    return this.conversationsService.assign(me.tenantId.toString(), id, userId);
  }

  @Post(':id/reply')
  async sendReply(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body('body') body: string,
    @Body('cc') cc?: { address: string; name?: string }[],
  ) {
    if (!body?.trim()) throw new BadRequestException('El cuerpo del mensaje es obligatorio');
    return this.conversationsService.sendReply(me.tenantId.toString(), id, body, cc);
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
