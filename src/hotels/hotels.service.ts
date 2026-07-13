import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Hotel, HotelDocument } from './schemas/hotel.schema';
import { CreateHotelSchema, CreateHotelDto } from './dto/create-hotel.dto';
import { UpdateHotelSchema, UpdateHotelDto } from './dto/update-hotel.dto';

@Injectable()
export class HotelsService {
  constructor(@InjectModel(Hotel.name) private readonly hotelModel: Model<HotelDocument>) {}

  async create(tenantId: string, dto: CreateHotelDto): Promise<HotelDocument> {
    CreateHotelSchema.parse(dto);

    const exists = await this.hotelModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      name: dto.name.trim(),
    });
    if (exists) throw new ConflictException('Ya existe un hotel con ese nombre en este tenant');

    return this.hotelModel.create({
      tenantId: new Types.ObjectId(tenantId),
      name: dto.name,
      tone: dto.tone ?? '',
      signature: dto.signature ?? '',
      brandInfo: dto.brandInfo ?? '',
      aiRules: dto.aiRules ?? [],
      active: true,
    });
  }

  async findAll(tenantId: string): Promise<HotelDocument[]> {
    return this.hotelModel
      .find({ tenantId: new Types.ObjectId(tenantId) })
      .sort({ name: 1 })
      .exec();
  }

  async findOne(tenantId: string, hotelId: string): Promise<HotelDocument> {
    const hotel = await this.hotelModel
      .findOne({
        _id: new Types.ObjectId(hotelId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .exec();

    if (!hotel) throw new NotFoundException('Hotel no encontrado');
    return hotel;
  }

  async update(tenantId: string, hotelId: string, dto: UpdateHotelDto): Promise<HotelDocument> {
    UpdateHotelSchema.parse(dto);

    const hotel = await this.hotelModel.findOne({
      _id: new Types.ObjectId(hotelId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!hotel) throw new NotFoundException('Hotel no encontrado');

    if (dto.name !== undefined) hotel.name = dto.name;
    if (dto.tone !== undefined) hotel.tone = dto.tone;
    if (dto.signature !== undefined) hotel.signature = dto.signature;
    if (dto.brandInfo !== undefined) hotel.brandInfo = dto.brandInfo;
    if (dto.aiRules !== undefined) hotel.aiRules = dto.aiRules;
    if (dto.active !== undefined) hotel.active = dto.active;

    return hotel.save();
  }
}
