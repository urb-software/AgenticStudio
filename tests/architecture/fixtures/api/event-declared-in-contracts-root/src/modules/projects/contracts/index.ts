import { z } from 'zod';

export const ProjectCreatedEventSchema = z.object({ projectId: z.string() });

export type ProjectCreatedEvent = z.infer<typeof ProjectCreatedEventSchema>;
