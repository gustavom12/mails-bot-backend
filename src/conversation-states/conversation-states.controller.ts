import { Controller, Get, Post, Patch, Delete, Body, Param, HttpCode } from '@nestjs/common';
import { ConversationStatesService } from './conversation-states.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@Controller('conversation-states')
export class ConversationStatesController {
  constructor(private readonly service: ConversationStatesService) {}

  @Get()
  findAll(@CurrentUser() me: UserDocument) {
    return this.service.findAll(me.tenantId.toString());
  }

  @Roles('owner')
  @Post()
  create(@CurrentUser() me: UserDocument, @Body() body: unknown) {
    return this.service.create(me.tenantId.toString(), body as Parameters<ConversationStatesService['create']>[1]);
  }

  @Roles('owner')
  @Patch('reorder')
  @HttpCode(200)
  reorder(@CurrentUser() me: UserDocument, @Body('ids') ids: string[]) {
    return this.service.reorder(me.tenantId.toString(), ids);
  }

  @Roles('owner')
  @Patch(':id/set-default')
  @HttpCode(200)
  setDefault(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.service.setDefault(me.tenantId.toString(), id);
  }

  @Roles('owner')
  @Patch(':id')
  update(@CurrentUser() me: UserDocument, @Param('id') id: string, @Body() body: unknown) {
    return this.service.update(me.tenantId.toString(), id, body as Parameters<ConversationStatesService['update']>[2]);
  }

  @Roles('owner')
  @Delete(':id')
  @HttpCode(200)
  deactivate(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.service.update(me.tenantId.toString(), id, { active: false });
  }
}
