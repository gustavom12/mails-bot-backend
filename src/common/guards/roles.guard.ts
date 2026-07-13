import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { UserDocument, UserRole } from '../../users/schemas/user.schema';

interface RequestWithUser extends Request {
  user: UserDocument;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();

    if (!user) throw new ForbiddenException('Sin permisos');

    // owner siempre tiene acceso total
    if (user.role === 'owner') return true;

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('No tenés permisos para esta acción');
    }

    return true;
  }
}
