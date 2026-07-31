import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MailboxDocument = Mailbox & Document;

export type MailboxStatus = 'pending' | 'connected' | 'error';

@Schema({ timestamps: true, collection: 'mailboxes' })
export class Mailbox {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  @Prop({ required: true, trim: true, lowercase: true })
  declare email: string;

  @Prop({ required: true, enum: ['pending', 'connected', 'error'], default: 'pending' })
  declare status: MailboxStatus;

  // OAuth tokens — se almacenarán cifrados en Etapa 2
  @Prop({ type: String, default: null })
  declare accessToken: string | null;

  @Prop({ type: String, default: null })
  declare refreshToken: string | null;

  @Prop({ type: Date, default: null })
  declare tokenExpiresAt: Date | null;

  // ID de la cuenta en Aurinko — se guarda al hacer OAuth con Aurinko
  @Prop({ type: Number, default: null })
  declare aurinkoAccountId: number | null;

  @Prop({ default: true })
  declare active: boolean;
}

export const MailboxSchema = SchemaFactory.createForClass(Mailbox);

MailboxSchema.index({ tenantId: 1, email: 1 }, { unique: true });
