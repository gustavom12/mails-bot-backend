import { z } from 'zod';
import { ADMIN_MODULES } from '../../common/permissions/admin-modules';

const HotelPermissionSchema = z.object({
  hotelId: z.string().min(1),
  modules: z.array(z.enum(ADMIN_MODULES)),
});

export const CreateUserSchema = z.object({
  email: z.string().email('Email inválido'),
  password: z
    .string()
    .min(8, 'La contraseña debe tener al menos 8 caracteres')
    .regex(/[A-Z]/, 'Debe contener al menos una mayúscula')
    .regex(/[0-9]/, 'Debe contener al menos un número'),
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').trim(),
  role: z.enum(['owner', 'admin']),
  hotelPermissions: z.array(HotelPermissionSchema).optional().default([]),
});

export type CreateUserDto = z.infer<typeof CreateUserSchema>;
