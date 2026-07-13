import { z } from 'zod';

export const CreateResponseTemplateSchema = z.object({
  hotelId: z.string().min(1, 'hotelId es requerido'),
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').trim(),
  description: z.string().min(5, 'La descripción debe tener al menos 5 caracteres').trim(),
  body: z.string().min(10, 'El contenido debe tener al menos 10 caracteres'),
  tags: z.array(z.string().trim().min(1)).optional().default([]),
});

export type CreateResponseTemplateDto = z.infer<typeof CreateResponseTemplateSchema>;
