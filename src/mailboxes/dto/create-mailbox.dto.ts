import { z } from 'zod';

export const CreateMailboxSchema = z.object({
  hotelId: z.string().min(1, 'El hotelId es requerido'),
  email: z.string().email('Email inválido'),
});

export type CreateMailboxDto = z.infer<typeof CreateMailboxSchema>;
