import { z } from 'zod';

export const CreateHotelSchema = z.object({
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').trim(),
  tone: z.string().trim().optional().default(''),
  signature: z.string().trim().optional().default(''),
  brandInfo: z.string().trim().optional().default(''),
  aiRules: z.array(z.string().trim()).optional().default([]),
});

export type CreateHotelDto = z.infer<typeof CreateHotelSchema>;
