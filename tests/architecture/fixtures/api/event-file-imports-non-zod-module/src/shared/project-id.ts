import { z } from 'zod';

export const ProjectIdSchema = z.object({ projectId: z.string() });
