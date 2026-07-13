import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type TenantDocument = Tenant & Document;

@Schema({ timestamps: true, collection: 'tenants' })
export class Tenant {
  @Prop({ required: true, trim: true })
  declare name: string;

  @Prop({ default: true })
  declare active: boolean;
}

export const TenantSchema = SchemaFactory.createForClass(Tenant);
