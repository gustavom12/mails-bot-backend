import { z } from 'zod';

export const CreateHotelSchema = z.object({
  mailboxId: z.string().min(1, 'La casilla es requerida'),
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').trim(),
  tone: z.string().trim().optional().default(''),
  signature: z.string().trim().optional().default(''),
  brandInfo: z.string().trim().optional().default(''),
  aiRules: z.array(z.string().trim()).optional().default([]),
  // Auto-asignación de hotel: términos a buscar en el asunto y dominios propios.
  matchAliases: z.array(z.string().trim().min(3)).optional().default([]),
  matchDomains: z.array(z.string().trim().toLowerCase()).optional().default([]),
});

export type CreateHotelDto = z.infer<typeof CreateHotelSchema>;
