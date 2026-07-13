import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
} from '@nestjs/common';
import { TemplatesService } from './templates.service';
import { Permissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@Controller('templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  /**
   * Lista templates. Owner puede ver todos; admins deben pasar ?hotelId=.
   * El guard de permisos exige hotelId para admins cuando la ruta lleva @Permissions.
   */
  @Permissions('templates')
  @Get()
  findAll(@CurrentUser() me: UserDocument, @Query('hotelId') hotelId?: string) {
    return this.templatesService.findAll(me.tenantId.toString(), hotelId);
  }

  @Permissions('templates')
  @Get(':id')
  findOne(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.templatesService.findOne(me.tenantId.toString(), id);
  }

  @Permissions('templates')
  @Post()
  create(@CurrentUser() me: UserDocument, @Body() body: unknown) {
    return this.templatesService.create(
      me.tenantId.toString(),
      me._id.toString(),
      body as Parameters<TemplatesService['create']>[2],
    );
  }

  @Permissions('templates')
  @Patch(':id')
  update(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.templatesService.update(
      me.tenantId.toString(),
      id,
      body as Parameters<TemplatesService['update']>[2],
    );
  }

  @Permissions('templates')
  @Delete(':id')
  remove(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.templatesService.remove(me.tenantId.toString(), id);
  }
}
