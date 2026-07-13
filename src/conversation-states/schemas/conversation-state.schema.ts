import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConversationStateDocument = ConversationState & Document;

@Schema({ timestamps: true, collection: 'conversation_states' })
export class ConversationState {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  declare name: string;

  @Prop({ default: '#6b7280' })
  declare color: string;

  @Prop({ required: true, default: 0 })
  declare order: number;

  @Prop({ default: false })
  declare isDefault: boolean;

  @Prop({ default: false })
  declare isClosed: boolean;

  @Prop({ default: true })
  declare active: boolean;
}

export const ConversationStateSchema = SchemaFactory.createForClass(ConversationState);

ConversationStateSchema.index({ tenantId: 1, order: 1 });
ConversationStateSchema.index({ tenantId: 1, name: 1 }, { unique: true });
