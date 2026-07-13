import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { User, UserDocument } from './schemas/user.schema';
import { CreateUserSchema, CreateUserDto } from './dto/create-user.dto';
import { UpdateUserSchema, UpdateUserDto, SetHotelPermissionsSchema, SetHotelPermissionsDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<UserDocument>) {}

  async create(tenantId: string, dto: CreateUserDto): Promise<UserDocument> {
    CreateUserSchema.parse(dto);

    const exists = await this.userModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      email: dto.email.toLowerCase(),
    });
    if (exists) throw new ConflictException('Ya existe un usuario con ese email en este tenant');

    const hashed = await bcrypt.hash(dto.password, 12);

    const hotelPermissions = (dto.hotelPermissions ?? []).map((p) => ({
      hotelId: new Types.ObjectId(p.hotelId),
      modules: p.modules,
    }));

    const created = await this.userModel.create({
      tenantId: new Types.ObjectId(tenantId),
      email: dto.email.toLowerCase(),
      password: hashed,
      name: dto.name,
      role: dto.role,
      hotelPermissions,
      active: true,
    });

    return this.userModel.findById(created._id).select('-password').exec() as Promise<UserDocument>;
  }

  async findAll(tenantId: string): Promise<Omit<UserDocument, 'password'>[]> {
    return this.userModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .select('-password')
      .lean()
      .exec() as unknown as Omit<UserDocument, 'password'>[];
  }

  async findOne(tenantId: string, userId: string): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({
        _id: new Types.ObjectId(userId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .select('-password')
      .exec();

    if (!user) throw new NotFoundException('Usuario no encontrado');
    return user;
  }

  async update(tenantId: string, userId: string, dto: UpdateUserDto): Promise<UserDocument> {
    UpdateUserSchema.parse(dto);

    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    if (dto.name !== undefined) user.name = dto.name;
    if (dto.role !== undefined) user.role = dto.role;
    if (dto.active !== undefined) user.active = dto.active;
    if (dto.password !== undefined) {
      user.password = await bcrypt.hash(dto.password, 12);
    }

    await user.save();
    return this.userModel.findById(user._id).select('-password').exec() as Promise<UserDocument>;
  }

  /**
   * Reemplaza los permisos por hotel del usuario.
   * Solo aplica a admins — al owner se le ignora (tiene acceso total por rol).
   */
  async setHotelPermissions(
    tenantId: string,
    userId: string,
    dto: SetHotelPermissionsDto,
  ): Promise<UserDocument> {
    SetHotelPermissionsSchema.parse(dto);

    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    if (user.role === 'owner') {
      throw new BadRequestException(
        'El owner tiene acceso total — no se pueden restringir sus permisos',
      );
    }

    user.hotelPermissions = dto.hotelPermissions.map((p) => ({
      hotelId: new Types.ObjectId(p.hotelId),
      modules: p.modules,
    }));

    await user.save();
    return this.userModel.findById(user._id).select('-password').exec() as Promise<UserDocument>;
  }

  async deactivate(tenantId: string, userId: string, requesterId: string): Promise<UserDocument> {
    if (userId === requesterId) {
      throw new ForbiddenException('No podés desactivarte a vos mismo');
    }

    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    user.active = false;
    await user.save();
    return this.userModel.findById(user._id).select('-password').exec() as Promise<UserDocument>;
  }
}
