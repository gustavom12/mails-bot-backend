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

  // Términos con los que se reconoce al hotel en el ASUNTO de un mail entrante
  // (ej: ["Hotel Parián", "Parián"]). Se usan para la auto-asignación de hotel.
  // Vacío = se usa el nombre del hotel como único término.
  @Prop({ type: [String], default: [] })
  declare matchAliases: string[];

  // Dominios de correo propios del hotel (ej: ["hotelparian.com"]). Un mail
  // entrante desde esos dominios se asigna a este hotel. Incluye subdominios.
  @Prop({ type: [String], default: [] })
  declare matchDomains: string[];

  @Prop({ default: true })
  declare active: boolean;
}

export const HotelSchema = SchemaFactory.createForClass(Hotel);

HotelSchema.index({ tenantId: 1, name: 1 }, { unique: true });
