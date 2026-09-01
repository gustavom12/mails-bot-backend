import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ConversationDocument = Conversation & Document;

export interface StatusHistoryEntry {
  stateId: Types.ObjectId;
  stateName: string;
  changedBy: Types.ObjectId | null;
  changedAt: Date;
  note?: string;
}

@Schema({ timestamps: true, collection: 'conversations' })
export class Conversation {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Mailbox', index: true })
  declare mailboxId: Types.ObjectId;

  // Hotel al que pertenece la conversacion. Puede quedar null hasta que el staff
  // lo asigne manualmente (una casilla puede servir a varios hoteles).
  @Prop({ type: Types.ObjectId, ref: 'Hotel', default: null })
  declare hotelId: Types.ObjectId | null;

  // true = el hotel lo puso una regla automática, no una persona. Sirve para
  // distinguir en la UI una asignación por regla de una decisión del staff.
  @Prop({ type: Boolean, default: false })
  declare hotelAutoAssigned: boolean;

  // Regla que asignó el hotel, para auditar por qué quedó donde quedó.
  @Prop({ type: String, default: null })
  declare hotelAssignmentReason: string | null;

  @Prop({ required: true, type: Types.ObjectId, ref: 'ConversationState' })
  declare stateId: Types.ObjectId;

  // ID único de Microsoft para deduplicación (índice único declarado abajo)
  @Prop({ required: true })
  declare internetMessageId: string;

  @Prop({ required: true })
  declare graphConversationId: string;

  @Prop({ required: true, trim: true })
  declare subject: string;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  declare assignedTo: Types.ObjectId | null;

  @Prop({ required: true })
  declare lastActivityAt: Date;

  @Prop({ required: true })
  declare contactEmail: string;

  @Prop({ type: String, default: null })
  declare contactName: string | null;

  // Marca de lectura: true = no leída (mensaje nuevo de cliente sin ver por un admin)
  @Prop({ type: Boolean, default: true })
  declare unread: boolean;

  // Dirección del último mensaje: 'inbound' = falta responder al cliente,
  // 'outbound' = ya respondimos y esperamos respuesta del cliente.
  @Prop({ type: String, enum: ['inbound', 'outbound'], default: 'inbound' })
  declare lastMessageDirection: 'inbound' | 'outbound';

  @Prop({
    type: [
      {
        stateId: { type: Types.ObjectId, ref: 'ConversationState', required: true },
        stateName: { type: String, required: true },
        changedBy: { type: Types.ObjectId, ref: 'User', required: false, default: null },
        changedAt: { type: Date, required: true },
        note: { type: String, required: false, default: null },
      },
    ],
    default: [],
  })
  declare statusHistory: StatusHistoryEntry[];

  @Prop({ type: String, default: null })
  declare aiSuggestedReply: string | null;

  @Prop({ type: String, enum: ['template', 'generated', null], default: null })
  declare aiReplySource: 'template' | 'generated' | null;

  @Prop({ type: Types.ObjectId, ref: 'ResponseTemplate', default: null })
  declare aiSuggestedTemplateId: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  declare aiProcessedAt: Date | null;

  @Prop({ type: String, default: null })
  declare aiSummary: string | null;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

ConversationSchema.index({ tenantId: 1, createdAt: -1 });
ConversationSchema.index({ tenantId: 1, mailboxId: 1, stateId: 1 });
ConversationSchema.index({ tenantId: 1, hotelId: 1 });
ConversationSchema.index({ tenantId: 1, stateId: 1, lastActivityAt: -1 });
ConversationSchema.index({ internetMessageId: 1 }, { unique: true });
ConversationSchema.index({ tenantId: 1, contactEmail: 1 });
ConversationSchema.index({ tenantId: 1, unread: 1 });
