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

  @Prop({ required: true, type: Types.ObjectId, ref: 'Hotel' })
  declare hotelId: Types.ObjectId;

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
ConversationSchema.index({ tenantId: 1, stateId: 1, lastActivityAt: -1 });
ConversationSchema.index({ internetMessageId: 1 }, { unique: true });
ConversationSchema.index({ tenantId: 1, contactEmail: 1 });
