import { z } from 'zod';

export const CreateMailboxSchema = z.object({
  email: z.string().email('Email inválido'),
});

export type CreateMailboxDto = z.infer<typeof CreateMailboxSchema>;
