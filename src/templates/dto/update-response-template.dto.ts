import { z } from 'zod';

export const UpdateResponseTemplateSchema = z.object({
  hotelId: z.string().min(1).optional(),
  name: z.string().min(2).trim().optional(),
  description: z.string().min(5).trim().optional(),
  body: z.string().min(10).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  active: z.boolean().optional(),
});

export type UpdateResponseTemplateDto = z.infer<typeof UpdateResponseTemplateSchema>;
