import { SetMetadata } from '@nestjs/common';
import { AdminModule } from '../permissions/admin-modules';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * Declara qué módulos necesita tener el usuario para el hotel en contexto.
 *
 * Uso:
 *   @Permissions('inbox', 'mail')
 *   @Get(':hotelId/conversations')
 *
 * El guard extrae el hotelId de req.params.hotelId (o req.query.hotelId como fallback).
 * El owner siempre pasa. El admin pasa solo si tiene todos los módulos requeridos
 * en su hotelPermissions para ese hotel.
 */
export const Permissions = (...modules: AdminModule[]) =>
  SetMetadata(PERMISSIONS_KEY, modules);
