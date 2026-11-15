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
  'unknown',
]);

/** How a Run was delivered (Issue #102): `none` is "No changes". */
export const runDeliverySchema = z.enum(['none', 'delivered', 'failed']);

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
    /** Whether the Run was given its Project's Environment file when it was claimed (Issue #104). */
    environmentFileSupplied: z.boolean(),
    /**
     * How the Run was delivered (Issue #102): `none` (succeeded with no changes: nothing pushed),
     * `delivered` (succeeded with a draft pull request) or `failed` (failed with
     * `delivery_failed`; the delivery can be retried). Absent until then.
     */
    delivery: runDeliverySchema.optional(),
    /** The Run's draft pull request on GitHub; present exactly when `delivery` is `delivered`. */
    pullRequest: z.object({ url: z.url(), number: z.int().positive() }).optional(),
    /** Present (true) while a requested delivery retry is pending or in progress. */
    deliveryRetryRequested: z.literal(true).optional(),
    /** The checks the agent reported failed in the latest Run step, when there are any. */
    failingChecks: z.array(z.string()).optional(),
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
  environmentFileSupplied: boolean;
  delivery: z.infer<typeof runDeliverySchema> | null;
  pullRequest: { url: string; number: number } | null;
  deliveryRequested: boolean;
  failingChecks: string[];
}): RunResponse {
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    task: run.task,
    state: run.state,
    startCommit: run.startCommit,
    createdAt: run.createdAt.toISOString(),
    environmentFileSupplied: run.environmentFileSupplied,
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
    ...(run.delivery ? { delivery: run.delivery } : {}),
    ...(run.pullRequest
      ? { pullRequest: { url: run.pullRequest.url, number: run.pullRequest.number } }
      : {}),
    ...(run.deliveryRequested ? { deliveryRetryRequested: true as const } : {}),
    ...(run.failingChecks.length > 0 ? { failingChecks: [...run.failingChecks] } : {}),
  };
}
