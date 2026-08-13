import { z } from 'zod';
import { htmlHasContent } from '../../common/utils/html';

export const CreateResponseTemplateSchema = z.object({
  hotelId: z.string().min(1, 'hotelId es requerido'),
  name: z.string().min(2, 'El nombre debe tener al menos 2 caracteres').trim(),
  description: z.string().min(5, 'La descripción debe tener al menos 5 caracteres').trim(),
  /** Cuerpo HTML de la respuesta (editor enriquecido). */
  body: z
    .string()
    .refine((v) => htmlHasContent(v, 10), {
      message: 'El contenido debe tener al menos 10 caracteres',
    }),
  tags: z.array(z.string().trim().min(1)).optional().default([]),
});

export type CreateResponseTemplateDto = z.infer<typeof CreateResponseTemplateSchema>;
