import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ConversationState, ConversationStateDocument } from './schemas/conversation-state.schema';
import { z } from 'zod';

const CreateStateSchema = z.object({
  name: z.string().min(1).max(50).trim(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color debe ser un hex válido (#rrggbb)').optional(),
  isClosed: z.boolean().optional().default(false),
});

const UpdateStateSchema = z.object({
  name: z.string().min(1).max(50).trim().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  isClosed: z.boolean().optional(),
  active: z.boolean().optional(),
});

export type CreateStateDto = z.infer<typeof CreateStateSchema>;
export type UpdateStateDto = z.infer<typeof UpdateStateSchema>;

export const DEFAULT_STATES = [
  { name: 'Nuevo',                      color: '#3b82f6', order: 0, isDefault: true,  isClosed: false },
  { name: 'Pendiente de revisión',       color: '#f59e0b', order: 1, isDefault: false, isClosed: false },
  { name: 'Respuesta preparada',         color: '#8b5cf6', order: 2, isDefault: false, isClosed: false },
  { name: 'Esperando respuesta cliente', color: '#06b6d4', order: 3, isDefault: false, isClosed: false },
  { name: 'Requiere atención',           color: '#ef4444', order: 4, isDefault: false, isClosed: false },
  { name: 'Cerrado',                     color: '#6b7280', order: 5, isDefault: false, isClosed: true  },
];

@Injectable()
export class ConversationStatesService {
  constructor(
    @InjectModel(ConversationState.name)
    private readonly stateModel: Model<ConversationStateDocument>,
  ) {}

  async seedDefaults(tenantId: string): Promise<void> {
    const existing = await this.stateModel.countDocuments({ tenantId: new Types.ObjectId(tenantId) });
    if (existing > 0) return;

    await this.stateModel.insertMany(
      DEFAULT_STATES.map((s) => ({ ...s, tenantId: new Types.ObjectId(tenantId), active: true })),
    );
  }

  async findAll(tenantId: string): Promise<ConversationStateDocument[]> {
    return this.stateModel
      .find({ tenantId: new Types.ObjectId(tenantId), active: true })
      .sort({ order: 1 })
      .exec();
  }

  async findDefault(tenantId: string): Promise<ConversationStateDocument | null> {
    return this.stateModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      isDefault: true,
      active: true,
    });
  }

  async create(tenantId: string, dto: CreateStateDto): Promise<ConversationStateDocument> {
    CreateStateSchema.parse(dto);

    const exists = await this.stateModel.findOne({ tenantId: new Types.ObjectId(tenantId), name: dto.name });
    if (exists) throw new ConflictException('Ya existe un estado con ese nombre');

    const maxOrder = await this.stateModel
      .findOne({ tenantId: new Types.ObjectId(tenantId) })
      .sort({ order: -1 })
      .select('order');

    return this.stateModel.create({
      tenantId: new Types.ObjectId(tenantId),
      name: dto.name,
      color: dto.color ?? '#6b7280',
      order: maxOrder ? (maxOrder.order + 1) : 0,
      isDefault: false,
      isClosed: dto.isClosed ?? false,
      active: true,
    });
  }

  async update(tenantId: string, stateId: string, dto: UpdateStateDto): Promise<ConversationStateDocument> {
    UpdateStateSchema.parse(dto);

    const state = await this.stateModel.findOne({
      _id: new Types.ObjectId(stateId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!state) throw new NotFoundException('Estado no encontrado');

    if (dto.name !== undefined) state.name = dto.name;
    if (dto.color !== undefined) state.color = dto.color;
    if (dto.isClosed !== undefined) state.isClosed = dto.isClosed;
    if (dto.active !== undefined) {
      if (!dto.active && state.isDefault) throw new BadRequestException('No se puede desactivar el estado por defecto');
      state.active = dto.active;
    }

    return state.save();
  }

  async reorder(tenantId: string, orderedIds: string[]): Promise<void> {
    await Promise.all(
      orderedIds.map((id, index) =>
        this.stateModel.updateOne(
          { _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(tenantId) },
          { order: index },
        ),
      ),
    );
  }

  async setDefault(tenantId: string, stateId: string): Promise<ConversationStateDocument> {
    await this.stateModel.updateMany({ tenantId: new Types.ObjectId(tenantId) }, { isDefault: false });

    const state = await this.stateModel.findOneAndUpdate(
      { _id: new Types.ObjectId(stateId), tenantId: new Types.ObjectId(tenantId) },
      { isDefault: true },
      { new: true },
    );
    if (!state) throw new NotFoundException('Estado no encontrado');
    return state;
  }
}
