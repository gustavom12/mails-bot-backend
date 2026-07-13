import { Controller, Get, Post, Patch, Body, Param } from '@nestjs/common';
import { HotelsService } from './hotels.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@Controller('hotels')
export class HotelsController {
  constructor(private readonly hotelsService: HotelsService) {}

  @Roles('owner')
  @Post()
  create(@CurrentUser() me: UserDocument, @Body() body: unknown) {
    return this.hotelsService.create(
      me.tenantId.toString(),
      body as Parameters<HotelsService['create']>[1],
    );
  }

  @Get()
  findAll(@CurrentUser() me: UserDocument) {
    return this.hotelsService.findAll(me.tenantId.toString());
  }

  @Get(':id')
  findOne(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.hotelsService.findOne(me.tenantId.toString(), id);
  }

  @Roles('owner')
  @Patch(':id')
  update(@CurrentUser() me: UserDocument, @Param('id') id: string, @Body() body: unknown) {
    return this.hotelsService.update(
      me.tenantId.toString(),
      id,
      body as Parameters<HotelsService['update']>[2],
    );
  }
}
