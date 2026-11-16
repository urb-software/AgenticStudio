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

/**
 * Where a Run's pull request stands on the Git host (Issue #142): a second list next to the
 * domain's, pinned to it by a test. `draft` and `open` are open; `missing` is a pull request or
 * Run branch that was not found (gone, or not visible to the Agent account).
 */
export const pullRequestStateSchema = z.enum(['draft', 'open', 'merged', 'closed', 'missing']);

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

/**
 * Why a Run cannot take a Follow-up now (Issue #141): a second list next to the domain's,
 * pinned to it by a test.
 */
export const followUpRefusalSchema = z.enum([
  'not_finished',
  'follow_up_queued',
  'pull_request_merged',
  'pull_request_closed',
  'pull_request_missing',
  'working_copy_removed',
  'no_session',
  'step_total_reached',
  'provider_unavailable',
  'worker_unavailable',
]);

/**
 * One turn of the Run's conversation (Issue #103): the Task, a question, an answer, or a
 * Follow-up the operator sent to the finished Run (Issue #141).
 */
export const runMessageResponseSchema = z
  .object({
    /** `studio` (review S1 of #150): Studio's record of how a part of the Run ended. */
    role: z.enum(['operator', 'agent', 'studio']),
    kind: z.enum(['task', 'question', 'answer', 'follow_up', 'part_end']),
    /** A part's end: the failure detail or the cancellation reason (may be empty). */
    text: z.string(),
    /**
     * With `part_end` only (review S1 of #150): how the part before a Follow-up ended: its
     * state, failure code and delivery.
     */
    end: z
      .object({
        state: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']),
        failureCode: runFailureCodeSchema.optional(),
        delivery: runDeliverySchema.optional(),
      })
      .meta({ id: 'RunPartEnd' })
      .optional(),
    /**
     * With `follow_up` only (Issue #147): `bring_up_to_date`, the operator's request to merge the
     * integration branch into the Run branch; `text` is then the operator's optional note (empty
     * when there is none).
     */
    source: z.literal('bring_up_to_date').optional(),
    /**
     * With `source` only: the integration branch commit the Run branch has merged, once the
     * agent worker reported it (absent when nothing was merged, or not yet).
     */
    mergedCommit: z.string().optional(),
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
    /**
     * The commits on the Run branch since the start commit, oldest first (at most 200). `pushed`
     * (Issue #141): the commit is on the remote Run branch; otherwise it exists only in the
     * Working copy. Absent on every commit when the pushed commit is not among the listed ones
     * (review S5 of #150): which are pushed is then unknown.
     */
    commits: z
      .array(z.object({ id: z.string(), subject: z.string(), pushed: z.boolean().optional() }))
      .optional(),
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
        /** The most Run steps of the first part, and of each Follow-up (Issue #141). */
        maxSteps: z.int().min(1),
        waitingDays: z.int().min(1),
        /** The most Run steps in total; past it the Run takes no Follow-up (Issue #141). */
        maxTotalSteps: z.int().min(1),
      })
      .meta({ id: 'RunLimits' }),
    /**
     * The Run step totals (Issue #141): how many Run steps the Run has taken, and how many of
     * them in its current part (the first part, or the latest Follow-up).
     */
    steps: z
      .object({ used: z.int().min(0), usedInPart: z.int().min(0) })
      .meta({ id: 'RunStepTotals' }),
    /** How many Follow-ups the operator sent to the Run (Issue #141); 0 when none. */
    followUps: z.int().min(0),
    /**
     * Whether the Run can take a Follow-up now, and if not, why (Issue #141). In single-Run
     * answers only (`GET /api/runs/:runId` and the Follow-up command).
     */
    followUp: z
      .object({ allowed: z.boolean(), reason: followUpRefusalSchema.optional() })
      .meta({ id: 'RunFollowUpEligibility' })
      .optional(),
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
    /**
     * The Run's draft pull request on GitHub: present when `delivery` is `delivered`, and kept
     * while a Follow-up works on the Run or after it ended otherwise (Issue #141: one Run, at
     * most one pull request).
     */
    pullRequest: z
      .object({
        url: z.url(),
        number: z.int().positive(),
        /**
         * Issue #142: where the pull request stood when the agent worker last read it through the
         * Agent account; absent until the first lookup succeeded. The last known state is kept
         * when a later lookup fails.
         */
        state: pullRequestStateSchema.optional(),
        /** Commits the Run branch is behind / ahead of the integration branch at that lookup. */
        behindBy: z.int().min(0).optional(),
        aheadBy: z.int().min(0).optional(),
        /** Whether GitHub says it can be merged without conflicts; absent when it did not say. */
        mergeable: z.boolean().optional(),
        /** When the state was last read; absent until then. */
        refreshedAt: z.iso.datetime().optional(),
        /**
         * Why the latest refresh failed, or that no agent worker is connected to carry it out;
         * text for the operator.
         */
        refreshError: z.string().optional(),
        /** A rate-limited refresh is tried again at this time. */
        retryAt: z.iso.datetime().optional(),
        /** Present (true) while a refresh waits for an agent worker or is being carried out. */
        refreshing: z.literal(true).optional(),
      })
      .meta({ id: 'RunPullRequest' })
      .optional(),
    /** Present (true) while a requested delivery retry is pending or in progress. */
    deliveryRetryRequested: z.literal(true).optional(),
    /**
     * Present (true) when the Run stopped at the subscription's usage limit and the operator can
     * resume it (`POST /api/runs/:runId/resume`, Issue #105).
     */
    resumable: z.literal(true).optional(),
    /** The checks the agent reported failed in the latest Run step, when there are any. */
    failingChecks: z.array(z.string()).optional(),
    /** Present exactly while the Run waits for the operator's answer to it (Issue #103). */
    question: runQuestionResponseSchema.optional(),
    /**
     * The conversation, in order (Issue #103): the Task, then each question of the agent, each
     * answer and each Follow-up of the operator (Issue #141). Everything the agent wrote is plain
     * text. In single-Run answers only (`GET /api/runs/:runId` and the commands); lists leave it
     * and `question` out.
     */
    messages: z.array(runMessageResponseSchema).optional(),
  })
  .meta({ id: 'Run' });

export class RunResponseDto extends createZodDto(runResponseSchema) {}

/** A list of Runs, newest first (by creation time, then id). */
export const runListResponseSchema = z.array(runResponseSchema).meta({ id: 'RunList' });

export class RunListResponseDto extends createZodDto(runListResponseSchema) {}

export type RunResponse = z.infer<typeof runResponseSchema>;

export function toRunResponse(
  run: {
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
    limits: { stepMinutes: number; maxSteps: number; waitingDays: number; maxTotalSteps: number };
    stepCount: number;
    stepsBeforePart: number;
    followUpCount: number;
    pushedCommit: string | null;
    cancelRequestedAt: Date | null;
    cancellation: { by: z.infer<typeof runCancelledBySchema>; reason: string } | null;
    delivery: z.infer<typeof runDeliverySchema> | null;
    pullRequest: { url: string; number: number } | null;
    deliveryRequested: boolean;
    pullRequestStatus: {
      state: z.infer<typeof pullRequestStateSchema> | null;
      behindBy: number | null;
      aheadBy: number | null;
      mergeable: boolean | null;
      refreshedAt: Date | null;
      refreshError: string | null;
      retryAt: Date | null;
      refreshRequestedAt: Date | null;
    };
    failingChecks: string[];
    sessionRef: string | null;
    messages: (
      | {
          kind: 'question';
          question: { text: string; options?: string[]; recommendation?: string };
          at: Date;
        }
      | { kind: 'answer'; text: string; at: Date }
      | {
          kind: 'follow_up';
          text: string;
          at: Date;
          source?: 'bring_up_to_date';
          mergedCommit?: string;
        }
      | {
          kind: 'part_end';
          state: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
          failureCode: z.infer<typeof runFailureCodeSchema> | null;
          delivery: z.infer<typeof runDeliverySchema> | null;
          detail: string;
          at: Date;
        }
    )[];
  },
  followUp?: { allowed: true } | { allowed: false; reason: z.infer<typeof followUpRefusalSchema> },
  /**
   * Issue #142: whether an agent worker is connected, when the caller knows. A refresh that
   * waits while none is says so instead of loading for ever.
   */
  workerConnected?: boolean,
): RunResponse {
  const last = run.messages.at(-1);
  // Issue #141: the commits up to and including the pushed one are on the remote Run branch.
  // A pushed commit that is not in the list (rewritten history, or older than the listed
  // commits) leaves each commit's pushed state unknown (review S5 of #150): no `pushed` field.
  const pushedUpTo = run.workingCopy
    ? run.workingCopy.commits.findIndex((commit) => commit.id === run.pushedCommit)
    : -1;
  const pushedKnown = run.pushedCommit === null || pushedUpTo !== -1;
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
          commits: run.workingCopy.commits.map(({ id, subject }, index) => ({
            id,
            subject,
            ...(pushedKnown ? { pushed: index <= pushedUpTo } : {}),
          })),
          hasUncommittedChanges: run.workingCopy.hasUncommittedChanges,
        }
      : {}),
    limits: {
      stepMinutes: run.limits.stepMinutes,
      maxSteps: run.limits.maxSteps,
      waitingDays: run.limits.waitingDays,
      maxTotalSteps: run.limits.maxTotalSteps,
    },
    steps: {
      used: run.stepCount,
      usedInPart: Math.max(0, run.stepCount - run.stepsBeforePart),
    },
    followUps: run.followUpCount,
    ...(followUp
      ? {
          followUp: followUp.allowed
            ? { allowed: true }
            : { allowed: false, reason: followUp.reason },
        }
      : {}),
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt.toISOString() } : {}),
    ...(run.cancellation
      ? { cancellation: { by: run.cancellation.by, reason: run.cancellation.reason } }
      : {}),
    ...(run.delivery ? { delivery: run.delivery } : {}),
    ...(run.pullRequest
      ? {
          pullRequest: toPullRequestResponse(
            run.pullRequest,
            run.pullRequestStatus,
            workerConnected,
          ),
        }
      : {}),
    ...(run.deliveryRequested ? { deliveryRetryRequested: true as const } : {}),
    // The domain's canResumeAfterUsageLimit, on the plain shape (Issue #105).
    ...(run.state === 'failed' &&
    run.failure?.code === 'usage_limit' &&
    run.sessionRef !== null &&
    run.workingCopy !== null &&
    run.cancelRequestedAt === null
      ? { resumable: true as const }
      : {}),
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
        message.kind === 'part_end'
          ? {
              role: 'studio' as const,
              kind: 'part_end' as const,
              text: message.detail,
              end: {
                state: message.state,
                ...(message.failureCode ? { failureCode: message.failureCode } : {}),
                ...(message.delivery ? { delivery: message.delivery } : {}),
              },
              at: message.at.toISOString(),
            }
          : message.kind === 'question'
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
                kind: message.kind,
                text: message.text,
                ...(message.kind === 'follow_up' && message.source !== undefined
                  ? {
                      source: message.source,
                      ...(message.mergedCommit === undefined
                        ? {}
                        : { mergedCommit: message.mergedCommit }),
                    }
                  : {}),
                at: message.at.toISOString(),
              },
      ),
    ],
  };
}

/** What a refresh that waits for an agent worker says while none is connected (Issue #142). */
export const NO_WORKER_FOR_REFRESH =
  'The agent worker is not connected, so the pull request state could not be refreshed.';

function toPullRequestResponse(
  pullRequest: { url: string; number: number },
  status: Parameters<typeof toRunResponse>[0]['pullRequestStatus'],
  workerConnected: boolean | undefined,
): NonNullable<RunResponse['pullRequest']> {
  const waiting = status.refreshRequestedAt !== null;
  const noWorker = waiting && workerConnected === false;
  const error = status.refreshError ?? (noWorker ? NO_WORKER_FOR_REFRESH : null);
  return {
    url: pullRequest.url,
    number: pullRequest.number,
    ...(status.state ? { state: status.state } : {}),
    ...(status.behindBy === null ? {} : { behindBy: status.behindBy }),
    ...(status.aheadBy === null ? {} : { aheadBy: status.aheadBy }),
    ...(status.mergeable === null ? {} : { mergeable: status.mergeable }),
    ...(status.refreshedAt ? { refreshedAt: status.refreshedAt.toISOString() } : {}),
    ...(error ? { refreshError: error } : {}),
    ...(status.retryAt ? { retryAt: status.retryAt.toISOString() } : {}),
    ...(waiting && !noWorker ? { refreshing: true as const } : {}),
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
