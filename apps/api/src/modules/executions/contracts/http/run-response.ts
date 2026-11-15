import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A Run in operator API responses (Issue #96), shared by the features of this module only
 * (backend.md §2). Self-contained: the enums are a second list next to the domain's, pinned
 * to it by a test, and the mapper takes a plain shape. Optional fields are left out when
 * they have no value.
 */
export const runStateSchema = z.enum([
  'queued',
  'preparing',
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

export const runProviderSchema = z.enum(['claude_code', 'codex']);

export const runFailureCodeSchema = z.enum([
  'provider_disabled',
  'preparation_failed',
  'agent_failed',
  'usage_limit',
  'worker_lost',
  'delivery_failed',
  'step_limit',
  'unknown',
]);

/** Who cancelled a Run (Issue #100). */
export const runCancelledBySchema = z.enum(['operator', 'system']);

export const runResponseSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    provider: runProviderSchema,
    task: z.string(),
    state: runStateSchema,
    /** The integration branch's commit the Run starts from. */
    startCommit: z.string(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    failure: z.object({ code: runFailureCodeSchema, detail: z.string() }).optional(),
    /**
     * The Run branch in the Working copy (Issue #98); with `commits` and
     * `hasUncommittedChanges`, present once the agent worker has reported a Run step.
     */
    runBranch: z.string().optional(),
    /** The commits on the Run branch since the start commit, oldest first (at most 200). */
    commits: z.array(z.object({ id: z.string(), subject: z.string() })).optional(),
    /** Whether the Working copy held uncommitted changes after the latest Run step. */
    hasUncommittedChanges: z.boolean().optional(),
    /**
     * The limits in force for this Run (Issue #100): the longest a Run step may work, the most
     * Run steps it may take, and the days it may wait for the operator before it is cancelled.
     */
    limits: z
      .object({
        stepMinutes: z.int().min(1),
        maxSteps: z.int().min(1),
        waitingDays: z.int().min(1),
      })
      .meta({ id: 'RunLimits' }),
    /**
     * When the operator asked to cancel a preparing or running Run (Issue #100): the agent
     * worker is stopping it, and the Run ends as `cancelled` once it confirms.
     */
    cancelRequestedAt: z.iso.datetime().optional(),
    /** Present exactly when `cancelled`: who cancelled it and why. */
    cancellation: z.object({ by: runCancelledBySchema, reason: z.string() }).optional(),
  })
  .meta({ id: 'Run' });

export class RunResponseDto extends createZodDto(runResponseSchema) {}

/** A list of Runs, newest first (by creation time, then id). */
export const runListResponseSchema = z.array(runResponseSchema).meta({ id: 'RunList' });

export class RunListResponseDto extends createZodDto(runListResponseSchema) {}

export type RunResponse = z.infer<typeof runResponseSchema>;

export function toRunResponse(run: {
  id: string;
  projectId: string;
  provider: z.infer<typeof runProviderSchema>;
  task: string;
  state: z.infer<typeof runStateSchema>;
  startCommit: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  failure: { code: z.infer<typeof runFailureCodeSchema>; detail: string } | null;
  workingCopy: {
    runBranch: string;
    commits: { id: string; subject: string }[];
    hasUncommittedChanges: boolean;
  } | null;
  limits: { stepMinutes: number; maxSteps: number; waitingDays: number };
  cancelRequestedAt: Date | null;
  cancellation: { by: z.infer<typeof runCancelledBySchema>; reason: string } | null;
}): RunResponse {
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    task: run.task,
    state: run.state,
    startCommit: run.startCommit,
    createdAt: run.createdAt.toISOString(),
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.finishedAt ? { finishedAt: run.finishedAt.toISOString() } : {}),
    ...(run.failure ? { failure: { code: run.failure.code, detail: run.failure.detail } } : {}),
    ...(run.workingCopy
      ? {
          runBranch: run.workingCopy.runBranch,
          commits: run.workingCopy.commits.map(({ id, subject }) => ({ id, subject })),
          hasUncommittedChanges: run.workingCopy.hasUncommittedChanges,
        }
      : {}),
    limits: {
      stepMinutes: run.limits.stepMinutes,
      maxSteps: run.limits.maxSteps,
      waitingDays: run.limits.waitingDays,
    },
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt.toISOString() } : {}),
    ...(run.cancellation
      ? { cancellation: { by: run.cancellation.by, reason: run.cancellation.reason } }
      : {}),
  };
}
