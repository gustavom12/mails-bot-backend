import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Mailbox, MailboxDocument } from './schemas/mailbox.schema';
import { Hotel, HotelDocument } from '../hotels/schemas/hotel.schema';
import { CreateMailboxSchema, CreateMailboxDto } from './dto/create-mailbox.dto';

@Injectable()
export class MailboxesService {
  constructor(
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
    @InjectModel(Hotel.name) private readonly hotelModel: Model<HotelDocument>,
  ) {}

  async create(tenantId: string, dto: CreateMailboxDto): Promise<MailboxDocument> {
    CreateMailboxSchema.parse(dto);

    // Verificar que el hotel pertenece al tenant
    const hotel = await this.hotelModel.findOne({
      _id: new Types.ObjectId(dto.hotelId),
      tenantId: new Types.ObjectId(tenantId),
      active: true,
    });
    if (!hotel) throw new BadRequestException('Hotel no encontrado o inactivo');

    // Regla 1 hotel = 1 casilla
    const existingForHotel = await this.mailboxModel.findOne({
      hotelId: new Types.ObjectId(dto.hotelId),
    });
    if (existingForHotel) {
      throw new ConflictException('Este hotel ya tiene una casilla asignada');
    }

    // Email único dentro del tenant
    const existingEmail = await this.mailboxModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      email: dto.email.toLowerCase(),
    });
    if (existingEmail) {
      throw new ConflictException('Ya existe una casilla con ese email en este tenant');
    }

    return this.mailboxModel.create({
      tenantId: new Types.ObjectId(tenantId),
      hotelId: new Types.ObjectId(dto.hotelId),
      email: dto.email.toLowerCase(),
      status: 'pending',
      active: true,
    });
  }

  async findAll(tenantId: string): Promise<MailboxDocument[]> {
    return this.mailboxModel
      .find({ tenantId: new Types.ObjectId(tenantId), active: true })
      .populate('hotelId', 'name')
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(tenantId: string, mailboxId: string): Promise<MailboxDocument> {
    const mailbox = await this.mailboxModel
      .findOne({
        _id: new Types.ObjectId(mailboxId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .populate('hotelId', 'name')
      .exec();

    if (!mailbox) throw new NotFoundException('Casilla no encontrada');
    return mailbox;
  }

  async findByHotel(tenantId: string, hotelId: string): Promise<MailboxDocument | null> {
    return this.mailboxModel
      .findOne({
        hotelId: new Types.ObjectId(hotelId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .exec();
  }

  async deactivate(tenantId: string, mailboxId: string): Promise<MailboxDocument> {
    const mailbox = await this.mailboxModel.findOne({
      _id: new Types.ObjectId(mailboxId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!mailbox) throw new NotFoundException('Casilla no encontrada');

    mailbox.active = false;
    return mailbox.save();
  }

  async saveTokens(
    mailboxId: string,
    tenantId: string,
    data: {
      accessToken: string;
      refreshToken: string | null;
      tokenExpiresAt: Date | null;
      aurinkoAccountId?: number | null;
      status: 'connected' | 'error';
    },
  ): Promise<MailboxDocument> {
    const mailbox = await this.mailboxModel.findOne({
      _id: new Types.ObjectId(mailboxId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!mailbox) throw new NotFoundException('Casilla no encontrada');

    mailbox.accessToken = data.accessToken;
    mailbox.refreshToken = data.refreshToken;
    mailbox.tokenExpiresAt = data.tokenExpiresAt;
    mailbox.status = data.status;
    if (data.aurinkoAccountId !== undefined) mailbox.aurinkoAccountId = data.aurinkoAccountId;
    return mailbox.save();
  }

  async setStatus(
    mailboxId: string,
    tenantId: string,
    status: 'pending' | 'connected' | 'error',
  ): Promise<void> {
    await this.mailboxModel.updateOne(
      { _id: new Types.ObjectId(mailboxId), tenantId: new Types.ObjectId(tenantId) },
      { status },
    );
  }

  async getActiveWithTokens(tenantId: string): Promise<MailboxDocument[]> {
    return this.mailboxModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        status: 'connected',
        active: true,
      })
      .exec();
  }
}
