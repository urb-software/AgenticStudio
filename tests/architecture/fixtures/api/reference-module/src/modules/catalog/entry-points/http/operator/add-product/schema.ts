import { z } from 'zod';

export const AddProductBodySchema = z.object({ name: z.string().min(1) });
export type AddProductBody = z.infer<typeof AddProductBodySchema>;
