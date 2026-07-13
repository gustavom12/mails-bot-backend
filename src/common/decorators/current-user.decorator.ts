import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { UserDocument } from '../../users/schemas/user.schema';

interface RequestWithUser extends Request {
  user: UserDocument;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): UserDocument => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
