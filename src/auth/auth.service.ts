import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { Model } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from '../users/schemas/user.schema';

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<UserDocument | null> {
    const user = await this.userModel
      .findOne({ email: email.toLowerCase(), active: true })
      .exec();

    if (!user) return null;

    const valid = await bcrypt.compare(password, user.password);
    return valid ? user : null;
  }

  login(user: UserDocument): { access_token: string } {
    const payload = {
      sub: user._id.toString(),
      tenantId: user.tenantId.toString(),
      role: user.role,
    };

    return { access_token: this.jwtService.sign(payload) };
  }

  getProfile(user: UserDocument) {
    return {
      id: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: user.tenantId.toString(),
      hotelPermissions: user.hotelPermissions.map((p) => ({
        hotelId: p.hotelId.toString(),
        modules: p.modules,
      })),
    };
  }
}
