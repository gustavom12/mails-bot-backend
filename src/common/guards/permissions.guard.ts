import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { AdminModule } from '../permissions/admin-modules';
import { UserDocument } from '../../users/schemas/user.schema';

interface RequestWithUser extends Request {
  user: UserDocument;
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredModules = this.reflector.getAllAndOverride<AdminModule[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredModules || requiredModules.length === 0) return true;

    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const { user } = req;

    if (!user) throw new ForbiddenException('Sin permisos');

    // El owner tiene acceso total — nunca se le bloquea
    if (user.role === 'owner') return true;

    // Extraer hotelId del request (params → query → body)
    const hotelId: string | undefined =
      (req.params['hotelId'] as string | undefined) ??
      (req.query['hotelId'] as string | undefined) ??
      (req.body as Record<string, unknown>)?.['hotelId'] as string | undefined;

    if (!hotelId) {
      throw new ForbiddenException(
        'Se requiere hotelId para verificar permisos',
      );
    }

    const hotelPerm = user.hotelPermissions?.find(
      (p) => p.hotelId.toString() === hotelId,
    );

    if (!hotelPerm) {
      throw new ForbiddenException(`Sin acceso al hotel ${hotelId}`);
    }

    const missing = requiredModules.filter((m) => !hotelPerm.modules.includes(m));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Permiso requerido en módulo(s): ${missing.join(', ')}`,
      );
    }

    return true;
  }
}
