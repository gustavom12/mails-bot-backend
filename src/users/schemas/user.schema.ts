import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ADMIN_MODULES, AdminModule } from '../../common/permissions/admin-modules';

export type UserDocument = User & Document;

export type UserRole = 'owner' | 'admin';

/**
 * Permisos de un admin para un hotel específico.
 * El owner no usa esta estructura — tiene acceso total a todo.
 */
export interface HotelPermission {
  hotelId: Types.ObjectId;
  modules: AdminModule[];
}

@Schema({ timestamps: true, collection: 'users' })
export class User {
  @Prop({ required: true, type: Types.ObjectId, ref: 'Tenant', index: true })
  declare tenantId: Types.ObjectId;

  @Prop({ required: true, trim: true, lowercase: true })
  declare email: string;

  @Prop({ required: true })
  declare password: string;

  @Prop({ required: true, trim: true })
  declare name: string;

  @Prop({ required: true, enum: ['owner', 'admin'] })
  declare role: UserRole;

  /**
   * Lista de permisos por hotel para usuarios con rol admin.
   * Cada entrada indica a qué módulos tiene acceso en ese hotel.
   * El owner ignora este campo.
   */
  @Prop({
    type: [
      {
        hotelId: { type: Types.ObjectId, ref: 'Hotel', required: true },
        modules: [{ type: String, enum: ADMIN_MODULES }],
      },
    ],
    default: [],
  })
  declare hotelPermissions: HotelPermission[];

  @Prop({ default: true })
  declare active: boolean;
}

export const UserSchema = SchemaFactory.createForClass(User);

UserSchema.index({ tenantId: 1, email: 1 }, { unique: true });
