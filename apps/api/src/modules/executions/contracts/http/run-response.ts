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
/** How a Run was delivered (Issue #102): `none` is "No changes". */
export const runDeliverySchema = z.enum(['none', 'delivered', 'failed']);

/** The agent's open question (Issue #103): plain text, never markup. */
export const runQuestionResponseSchema = z
  .object({
    text: z.string(),
    /** The options the agent offers, when it offers any (at most six). */
    options: z.array(z.string()).optional(),
    /** The option the agent recommends, when it recommends one. */
    recommendation: z.string().optional(),
  })
  .meta({ id: 'RunQuestion' });

/** One turn of the Run's conversation (Issue #103): the Task, a question or an answer. */
export const runMessageResponseSchema = z
  .object({
    role: z.enum(['operator', 'agent']),
    kind: z.enum(['task', 'question', 'answer']),
    text: z.string(),
    /** A question's offered options, when it offered any (review M2 of #127). */
    options: z.array(z.string()).optional(),
    /** The option a question recommended, when it recommended one. */
    recommendation: z.string().optional(),
    at: z.iso.datetime(),
  })
  .meta({ id: 'RunMessage' });

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
    /** Present exactly while the Run waits for the operator's answer to it (Issue #103). */
    question: runQuestionResponseSchema.optional(),
    /**
     * The conversation, in order (Issue #103): the Task, then each question of the agent and
     * each answer of the operator. Everything the agent wrote is plain text. In single-Run
     * answers only (`GET /api/runs/:runId` and the commands); lists leave it and `question` out.
     */
    messages: z.array(runMessageResponseSchema).optional(),
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
  limits: { stepMinutes: number; maxSteps: number; waitingDays: number };
  cancelRequestedAt: Date | null;
  cancellation: { by: z.infer<typeof runCancelledBySchema>; reason: string } | null;
  delivery: z.infer<typeof runDeliverySchema> | null;
  pullRequest: { url: string; number: number } | null;
  deliveryRequested: boolean;
  failingChecks: string[];
  messages: (
    | {
        kind: 'question';
        question: { text: string; options?: string[]; recommendation?: string };
        at: Date;
      }
    | { kind: 'answer'; text: string; at: Date }
  )[];
}): RunResponse {
  const last = run.messages.at(-1);
  const open = run.state === 'waiting_for_operator' && last?.kind === 'question' ? last : null;
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
    limits: {
      stepMinutes: run.limits.stepMinutes,
      maxSteps: run.limits.maxSteps,
      waitingDays: run.limits.waitingDays,
    },
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt.toISOString() } : {}),
    ...(run.cancellation
      ? { cancellation: { by: run.cancellation.by, reason: run.cancellation.reason } }
      : {}),
    ...(run.delivery ? { delivery: run.delivery } : {}),
    ...(run.pullRequest
      ? { pullRequest: { url: run.pullRequest.url, number: run.pullRequest.number } }
      : {}),
    ...(run.deliveryRequested ? { deliveryRetryRequested: true as const } : {}),
    ...(run.failingChecks.length > 0 ? { failingChecks: [...run.failingChecks] } : {}),
    ...(open
      ? {
          question: {
            text: open.question.text,
            ...(open.question.options ? { options: [...open.question.options] } : {}),
            ...(open.question.recommendation === undefined
              ? {}
              : { recommendation: open.question.recommendation }),
          },
        }
      : {}),
    messages: [
      { role: 'operator', kind: 'task', text: run.task, at: run.createdAt.toISOString() },
      ...run.messages.map((message) =>
        message.kind === 'question'
          ? {
              role: 'agent' as const,
              kind: 'question' as const,
              text: message.question.text,
              ...(message.question.options ? { options: [...message.question.options] } : {}),
              ...(message.question.recommendation === undefined
                ? {}
                : { recommendation: message.question.recommendation }),
              at: message.at.toISOString(),
            }
          : {
              role: 'operator' as const,
              kind: 'answer' as const,
              text: message.text,
              at: message.at.toISOString(),
            },
      ),
    ],
  };
}

/**
 * A Run in a list (Issue #103, coordinator decision): the Run without its conversation
 * (`messages`) and open question, which only the single-Run answers carry.
 */
export function toRunListItem(run: Parameters<typeof toRunResponse>[0]): RunResponse {
  const { messages: _messages, question: _question, ...item } = toRunResponse(run);
  void _messages;
  void _question;
  return item;
}
