import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ResponseTemplate, ResponseTemplateDocument } from './schemas/response-template.schema';
import { CreateResponseTemplateSchema, CreateResponseTemplateDto } from './dto/create-response-template.dto';
import { UpdateResponseTemplateSchema, UpdateResponseTemplateDto } from './dto/update-response-template.dto';

@Injectable()
export class TemplatesService {
  constructor(
    @InjectModel(ResponseTemplate.name)
    private readonly templateModel: Model<ResponseTemplateDocument>,
  ) {}

  async create(tenantId: string, userId: string, dto: CreateResponseTemplateDto): Promise<ResponseTemplateDocument> {
    CreateResponseTemplateSchema.parse(dto);

    const exists = await this.templateModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      hotelId: new Types.ObjectId(dto.hotelId),
      name: dto.name.trim(),
    });
    if (exists) throw new ConflictException('Ya existe un template con ese nombre en este hotel');

    return this.templateModel.create({
      tenantId: new Types.ObjectId(tenantId),
      hotelId: new Types.ObjectId(dto.hotelId),
      name: dto.name,
      description: dto.description,
      body: dto.body,
      tags: dto.tags ?? [],
      active: true,
      createdBy: new Types.ObjectId(userId),
    });
  }

  async findAll(tenantId: string, hotelId?: string): Promise<ResponseTemplateDocument[]> {
    const query: Record<string, unknown> = {
      tenantId: new Types.ObjectId(tenantId),
      active: true,
    };
    if (hotelId) query.hotelId = new Types.ObjectId(hotelId);

    return this.templateModel
      .find(query)
      .sort({ name: 1 })
      .populate('hotelId', 'name')
      .exec();
  }

  async findOne(tenantId: string, templateId: string): Promise<ResponseTemplateDocument> {
    const template = await this.templateModel
      .findOne({
        _id: new Types.ObjectId(templateId),
        tenantId: new Types.ObjectId(tenantId),
      })
      .populate('hotelId', 'name')
      .exec();

    if (!template) throw new NotFoundException('Template no encontrado');
    return template;
  }

  async update(tenantId: string, templateId: string, dto: UpdateResponseTemplateDto): Promise<ResponseTemplateDocument> {
    UpdateResponseTemplateSchema.parse(dto);

    const template = await this.templateModel.findOne({
      _id: new Types.ObjectId(templateId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!template) throw new NotFoundException('Template no encontrado');

    if (dto.name !== undefined) template.name = dto.name;
    if (dto.description !== undefined) template.description = dto.description;
    if (dto.body !== undefined) template.body = dto.body;
    if (dto.tags !== undefined) template.tags = dto.tags;
    if (dto.active !== undefined) template.active = dto.active;

    return template.save();
  }

  async remove(tenantId: string, templateId: string): Promise<void> {
    const template = await this.templateModel.findOne({
      _id: new Types.ObjectId(templateId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!template) throw new NotFoundException('Template no encontrado');

    template.active = false;
    await template.save();
  }

  /**
   * Busca templates usando índice de texto para match por keywords.
   * Usado por el módulo de IA para encontrar templates relevantes.
   */
  async searchByText(
    tenantId: string,
    hotelId: string,
    text: string,
    limit = 5,
  ): Promise<ResponseTemplateDocument[]> {
    const baseQuery = {
      tenantId: new Types.ObjectId(tenantId),
      hotelId: new Types.ObjectId(hotelId),
      active: true,
    };

    const allForHotel = () =>
      this.templateModel.find(baseQuery).sort({ name: 1 }).limit(limit).exec();

    if (!text?.trim()) {
      return allForHotel();
    }

    const matches = await this.templateModel
      .find(
        { ...baseQuery, $text: { $search: text } },
        { score: { $meta: 'textScore' } },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(limit)
      .exec();

    // Fallback: si la búsqueda por texto no encuentra nada (typos, palabras que
    // no matchean exacto), devolver todos los templates activos del hotel para
    // que la IA pueda decidir cuál aplica.
    if (matches.length === 0) {
      return allForHotel();
    }

    return matches;
  }

  /**
   * Busca templates activos del hotel cuyos tags matchean alguno de los
   * valores dados (case-insensitive). Usado p.ej. para drafts de seguimiento.
   */
  async findByTags(
    tenantId: string,
    hotelId: string,
    tags: string[],
    limit = 5,
  ): Promise<ResponseTemplateDocument[]> {
    const normalized = tags.map((t) => t.trim()).filter(Boolean);
    if (normalized.length === 0) return [];

    const tagRegexes = normalized.map((t) => new RegExp(`^${escapeRegex(t)}$`, 'i'));

    return this.templateModel
      .find({
        tenantId: new Types.ObjectId(tenantId),
        hotelId: new Types.ObjectId(hotelId),
        active: true,
        tags: { $in: tagRegexes },
      })
      .sort({ name: 1 })
      .limit(limit)
      .exec();
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
