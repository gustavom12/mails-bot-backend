import { z } from 'zod';

export const UpdateHotelSchema = z.object({
  mailboxId: z.string().min(1).optional(),
  name: z.string().min(2).trim().optional(),
  tone: z.string().trim().optional(),
  signature: z.string().trim().optional(),
  brandInfo: z.string().trim().optional(),
  aiRules: z.array(z.string().trim()).optional(),
  active: z.boolean().optional(),
});

export type UpdateHotelDto = z.infer<typeof UpdateHotelSchema>;
