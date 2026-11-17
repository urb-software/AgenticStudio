import { z } from 'zod';

export const ExecutionLogEventSchema = z.object({ line: z.string(), at: z.iso.datetime() });

export type ExecutionLogEvent = z.infer<typeof ExecutionLogEventSchema>;
