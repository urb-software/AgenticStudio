import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const runEventKindSchema = z.enum([
  'message',
  'command',
  'output',
  'step_started',
  'step_finished',
  'notice',
]);

export const runEventSchema = z
  .object({
    seq: z.int().min(1),
    at: z.iso.datetime(),
    stepIndex: z.int().min(1),
    kind: runEventKindSchema,
    text: z.string(),
    truncated: z.literal(true).optional(),
    redacted: z.literal(true).optional(),
  })
  .meta({ id: 'RunEvent' });

export type RunEventResponse = z.infer<typeof runEventSchema>;

export const runEventPageSchema = z
  .object({
    events: z.array(runEventSchema),
    next: z.int().min(1).optional(),
  })
  .meta({ id: 'RunEventPage' });

export class RunEventPageDto extends createZodDto(runEventPageSchema) {}

export function toRunEventResponse(event: {
  seq: number;
  at: Date;
  stepIndex: number;
  kind: z.infer<typeof runEventKindSchema>;
  text: string;
  truncated: boolean;
  redacted: boolean;
}): RunEventResponse {
  return {
    seq: event.seq,
    at: event.at.toISOString(),
    stepIndex: event.stepIndex,
    kind: event.kind,
    text: event.text,
    ...(event.truncated ? { truncated: true as const } : {}),
    ...(event.redacted ? { redacted: true as const } : {}),
  };
}
