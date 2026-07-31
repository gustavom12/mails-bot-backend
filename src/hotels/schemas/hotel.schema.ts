import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type HotelDocument = Hotel & Document;

@Schema({ timestamps: true, collection: 'hotels' })
export class Hotel {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  // Casilla de correo asociada. Varios hoteles pueden compartir una misma casilla,
  // pero cada hotel tiene una sola. Nullable en el schema para no romper hoteles legacy.
  @Prop({ type: Types.ObjectId, ref: 'Mailbox', default: null, index: true })
  declare mailboxId: Types.ObjectId | null;

  @Prop({ required: true, trim: true })
  declare name: string;

  @Prop({ trim: true, default: '' })
  declare tone: string;

  @Prop({ trim: true, default: '' })
  declare signature: string;

  @Prop({ trim: true, default: '' })
  declare brandInfo: string;

  @Prop({ type: [String], default: [] })
  declare aiRules: string[];

  @Prop({ default: true })
  declare active: boolean;
}

export const HotelSchema = SchemaFactory.createForClass(Hotel);

HotelSchema.index({ tenantId: 1, name: 1 }, { unique: true });
