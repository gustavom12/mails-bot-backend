import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserDocument } from './schemas/user.schema';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Roles('owner')
  @Post()
  create(@CurrentUser() me: UserDocument, @Body() body: unknown) {
    return this.usersService.create(
      me.tenantId.toString(),
      body as Parameters<UsersService['create']>[1],
    );
  }

  @Get()
  findAll(@CurrentUser() me: UserDocument) {
    return this.usersService.findAll(me.tenantId.toString());
  }

  @Get(':id')
  findOne(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.usersService.findOne(me.tenantId.toString(), id);
  }

  @Roles('owner')
  @Patch(':id')
  update(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.update(
      me.tenantId.toString(),
      id,
      body as Parameters<UsersService['update']>[2],
    );
  }

  /**
   * Reemplaza los permisos por hotel de un admin.
   * Body: { hotelPermissions: [{ hotelId, modules[] }] }
   * Módulos válidos: inbox | mail | templates | config
   */
  @Roles('owner')
  @Patch(':id/hotel-permissions')
  setHotelPermissions(
    @CurrentUser() me: UserDocument,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.usersService.setHotelPermissions(
      me.tenantId.toString(),
      id,
      body as Parameters<UsersService['setHotelPermissions']>[2],
    );
  }

  @Roles('owner')
  @Delete(':id')
  @HttpCode(200)
  deactivate(@CurrentUser() me: UserDocument, @Param('id') id: string) {
    return this.usersService.deactivate(me.tenantId.toString(), id, me._id.toString());
  }
}
