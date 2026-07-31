import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Mailbox, MailboxDocument } from './schemas/mailbox.schema';
import { CreateMailboxSchema, CreateMailboxDto } from './dto/create-mailbox.dto';

@Injectable()
export class MailboxesService {
  constructor(
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
  ) {}

  async create(tenantId: string, dto: CreateMailboxDto): Promise<MailboxDocument> {
    CreateMailboxSchema.parse(dto);

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
      email: dto.email.toLowerCase(),
      status: 'pending',
      active: true,
    });
  }

  async findAll(tenantId: string): Promise<MailboxDocument[]> {
    return this.mailboxModel
      .find({ tenantId: new Types.ObjectId(tenantId), active: true })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(tenantId: string, mailboxId: string): Promise<MailboxDocument> {
    const mailbox = await this.mailboxModel
      .findOne({
        _id: new Types.ObjectId(mailboxId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .exec();

    if (!mailbox) throw new NotFoundException('Casilla no encontrada');
    return mailbox;
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
