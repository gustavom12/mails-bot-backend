import { z } from 'zod';
import { ADMIN_MODULES } from '../../common/permissions/admin-modules';

const HotelPermissionSchema = z.object({
  hotelId: z.string().min(1),
  modules: z.array(z.enum(ADMIN_MODULES)),
});

export const UpdateUserSchema = z.object({
  name: z.string().min(2).trim().optional(),
  password: z
    .string()
    .min(8)
    .regex(/[A-Z]/)
    .regex(/[0-9]/)
    .optional(),
  role: z.enum(['owner', 'admin']).optional(),
  active: z.boolean().optional(),
});

export type UpdateUserDto = z.infer<typeof UpdateUserSchema>;

/**
 * DTO dedicado para setear los permisos por hotel de un admin.
 * Se usa en PATCH /users/:id/hotel-permissions
 */
export const SetHotelPermissionsSchema = z.object({
  hotelPermissions: z.array(HotelPermissionSchema),
});

export type SetHotelPermissionsDto = z.infer<typeof SetHotelPermissionsSchema>;
