import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ResponseTemplateDocument = ResponseTemplate & Document;

@Schema({ timestamps: true, collection: 'response_templates' })
export class ResponseTemplate {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  @Prop({ required: true, type: Types.ObjectId, ref: 'Hotel', index: true })
  declare hotelId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  declare name: string;

  @Prop({ required: true, trim: true })
  declare description: string;

  @Prop({ required: true })
  declare body: string;

  @Prop({ type: [String], default: [] })
  declare tags: string[];

  @Prop({ default: true })
  declare active: boolean;

  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  declare createdBy: Types.ObjectId | null;
}

export const ResponseTemplateSchema = SchemaFactory.createForClass(ResponseTemplate);

ResponseTemplateSchema.index({ tenantId: 1, hotelId: 1 });
ResponseTemplateSchema.index({ tenantId: 1, hotelId: 1, name: 1 }, { unique: true });
ResponseTemplateSchema.index(
  { name: 'text', description: 'text', body: 'text', tags: 'text' },
  { weights: { name: 10, description: 5, body: 3, tags: 4 }, name: 'response_template_text_idx' },
);
