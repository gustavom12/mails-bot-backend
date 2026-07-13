import { Controller, Get, Post, Delete, Body, Param, HttpCode } from '@nestjs/common';
import { MailboxesService } from './mailboxes.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@Controller('mailboxes')
export class MailboxesController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  @Roles('owner')
  @Post()
  create(@CurrentUser() me: UserDocument, @Body() body: unknown) {
    return this.mailboxesService.create(
      me.tenantId.toString(),
      body as Parameters<MailboxesService['create']>[1],
    );
  }

  @Get()
  findAll(@CurrentUser() me: UserDocument) {
    return this.mailboxesService.findAll(me.tenantId.toString());
  }

  @Get(':id')
  findOne(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.mailboxesService.findOne(me.tenantId.toString(), id);
  }

  @Roles('owner')
  @Delete(':id')
  @HttpCode(200)
  deactivate(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.mailboxesService.deactivate(me.tenantId.toString(), id);
  }
}
