import { z } from 'zod';

export const ExecutionCompletedV1Schema = z.object({ executionId: z.string() });

export type ExecutionCompletedV1 = z.infer<typeof ExecutionCompletedV1Schema>;
