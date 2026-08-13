import { z } from 'zod';
import { htmlHasContent } from '../../common/utils/html';

export const UpdateResponseTemplateSchema = z.object({
  hotelId: z.string().min(1).optional(),
  name: z.string().min(2).trim().optional(),
  description: z.string().min(5).trim().optional(),
  /** Cuerpo HTML de la respuesta (editor enriquecido). */
  body: z
    .string()
    .refine((v) => htmlHasContent(v, 10), {
      message: 'El contenido debe tener al menos 10 caracteres',
    })
    .optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  active: z.boolean().optional(),
});

export type UpdateResponseTemplateDto = z.infer<typeof UpdateResponseTemplateSchema>;
