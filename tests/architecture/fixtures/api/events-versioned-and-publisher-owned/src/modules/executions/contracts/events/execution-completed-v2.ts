import { z } from 'zod';

export const ExecutionCompletedV2Schema = z.object({
  executionId: z.string(),
  projectId: z.string(),
  status: z.enum(['succeeded', 'failed']),
});

export type ExecutionCompletedV2 = z.infer<typeof ExecutionCompletedV2Schema>;
