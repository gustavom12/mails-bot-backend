import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../../users/schemas/user.schema';

export interface JwtPayload {
  sub: string;
  tenantId: string;
  role: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req) => req?.cookies?.['access_token'] as string | null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'fallback-secret',
    });
  }

  async validate(payload: JwtPayload): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({
        _id: new Types.ObjectId(payload.sub),
        tenantId: new Types.ObjectId(payload.tenantId),
        active: true,
      })
      .exec();

    if (!user) throw new UnauthorizedException('Sesión inválida o usuario inactivo');

    return user;
  }
}
