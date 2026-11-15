import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A Run's log in operator API responses (Issue #99), shared by the paged read and the live
 * stream (each stream message's `data` is one {@link runEventSchema} as JSON, its `id` the
 * seq). Self-contained like `run-response.ts`: the kinds are a second list next to the
 * domain's, pinned to it by a test.
 */
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
    /** Per Run, from 1, increasing; gaps are possible. */
    seq: z.int().min(1),
    at: z.iso.datetime(),
    /** The Run step the event belongs to: 1, 2, … */
    stepIndex: z.int().min(1),
    kind: runEventKindSchema,
    /** Redacted before it was stored; verbatim otherwise. */
    text: z.string(),
    /** Present when the text was cut to the per-event cap. */
    truncated: z.literal(true).optional(),
  })
  .meta({ id: 'RunEvent' });

export type RunEventResponse = z.infer<typeof runEventSchema>;

/** `GET /api/runs/:runId/events` response. */
export const runEventPageSchema = z
  .object({
    events: z.array(runEventSchema),
    /** Pass as `after` to read the next page; absent on the last page. */
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
}): RunEventResponse {
  return {
    seq: event.seq,
    at: event.at.toISOString(),
    stepIndex: event.stepIndex,
    kind: event.kind,
    text: event.text,
    ...(event.truncated ? { truncated: true as const } : {}),
  };
}
