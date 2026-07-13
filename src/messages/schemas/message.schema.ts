import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type MessageDocument = Message & Document;

export type MessageDirection = 'inbound' | 'outbound';

interface EmailAddress {
  name: string;
  address: string;
}

interface Attachment {
  name: string;
  contentType: string;
  s3Key: string;
  size: number;
}

@Schema({ timestamps: true, collection: 'messages' })
export class Message {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Conversation', index: true })
  declare conversationId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Mailbox' })
  declare mailboxId: Types.ObjectId;

  // ID del mensaje en Microsoft Graph
  @Prop({ required: true })
  declare graphMessageId: string;

  @Prop({ required: true })
  declare internetMessageId: string;

  @Prop({ required: true, trim: true })
  declare subject: string;

  @Prop({ type: Object, required: true })
  declare from: EmailAddress;

  @Prop({ type: [Object], default: [] })
  declare toRecipients: EmailAddress[];

  @Prop({ type: [Object], default: [] })
  declare ccRecipients: EmailAddress[];

  @Prop({ required: true })
  declare bodyHtml: string;

  @Prop({ default: '' })
  declare bodyPreview: string;

  @Prop({ required: true, enum: ['inbound', 'outbound'] })
  declare direction: MessageDirection;

  @Prop({ required: true })
  declare receivedAt: Date;

  // Referencias S3 de los adjuntos (no se guarda el archivo en Mongo)
  @Prop({ type: [Object], default: [] })
  declare attachments: Attachment[];

  // Si fue enviado desde la plataforma, quién lo aprobó
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  declare approvedBy: Types.ObjectId | null;
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.index({ tenantId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, receivedAt: 1 });
MessageSchema.index(
  { subject: 'text', bodyPreview: 'text' },
  { weights: { subject: 5, bodyPreview: 3 }, name: 'message_text_idx' },
);
