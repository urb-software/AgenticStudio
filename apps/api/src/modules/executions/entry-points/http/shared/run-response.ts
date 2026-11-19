import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

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

export const runCancelledBySchema = z.enum(['operator', 'system']);
export const runDeliverySchema = z.enum(['none', 'delivered', 'failed']);

export const pullRequestStateSchema = z.enum(['draft', 'open', 'merged', 'closed', 'missing']);

export const pullRequestCheckStateSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'skipped',
  'cancelled',
]);

export const failingChecksPreparationSchema = z.enum(['preparing', 'ready', 'failed']);

export const followUpSourceSchema = z.enum([
  'pull_request_checks',
  'bring_up_to_date',
  'review_comments',
]);

/** The agent's open question: plain text, never markup. */
export const runQuestionResponseSchema = z
  .object({
    text: z.string(),
    options: z.array(z.string()).optional(),
    recommendation: z.string().optional(),
  })
  .meta({ id: 'RunQuestion' });

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

export const runMessageResponseSchema = z
  .object({
    role: z.enum(['operator', 'agent', 'studio']),
    kind: z.enum(['task', 'question', 'answer', 'follow_up', 'part_end']),
    text: z.string(),
    end: z
      .object({
        state: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']),
        failureCode: runFailureCodeSchema.optional(),
        delivery: runDeliverySchema.optional(),
      })
      .meta({ id: 'RunPartEnd' })
      .optional(),
    mergedCommit: z.string().optional(),
    options: z.array(z.string()).optional(),
    recommendation: z.string().optional(),
    source: followUpSourceSchema.optional(),
    sourceCount: z.int().optional(),
    sourceAuthors: z.array(z.string()).optional(),
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
    startCommit: z.string(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    failure: z.object({ code: runFailureCodeSchema, detail: z.string() }).optional(),
    runBranch: z.string().optional(),
    /**
     * `pushed`: the commit is on the remote Run branch; otherwise it exists only in the Working
     * copy. Absent on every commit when the pushed commit is not among the listed ones: which are
     * pushed is unknown.
     */
    commits: z
      .array(z.object({ id: z.string(), subject: z.string(), pushed: z.boolean().optional() }))
      .optional(),
    hasUncommittedChanges: z.boolean().optional(),
    environmentFileSupplied: z.boolean(),
    limits: z
      .object({
        stepMinutes: z.int().min(1),
        maxSteps: z.int().min(1),
        waitingDays: z.int().min(1),
        maxTotalSteps: z.int().min(1),
      })
      .meta({ id: 'RunLimits' }),
    steps: z
      .object({ used: z.int().min(0), usedInPart: z.int().min(0) })
      .meta({ id: 'RunStepTotals' }),
    followUps: z.int().min(0),
    /** Single-Run answers only (`GET /api/runs/:runId` and the Follow-up command). */
    followUp: z
      .object({
        allowed: z.boolean(),
        reason: followUpRefusalSchema.optional(),
        openUntil: z.iso.datetime().optional(),
        removalPending: z.literal(true).optional(),
      })
      .meta({ id: 'RunFollowUpEligibility' })
      .optional(),
    cancelRequestedAt: z.iso.datetime().optional(),
    cancellation: z.object({ by: runCancelledBySchema, reason: z.string() }).optional(),
    delivery: runDeliverySchema.optional(),
    pullRequest: z
      .object({
        url: z.url(),
        number: z.int().positive(),
        state: pullRequestStateSchema.optional(),
        behindBy: z.int().min(0).optional(),
        aheadBy: z.int().min(0).optional(),
        mergeable: z.boolean().optional(),
        refreshedAt: z.iso.datetime().optional(),
        refreshError: z.string().optional(),
        retryAt: z.iso.datetime().optional(),
        refreshing: z.literal(true).optional(),
        checks: z
          .array(
            z
              .object({
                name: z.string(),
                state: pullRequestCheckStateSchema,
                durationSeconds: z.int().min(0).optional(),
                url: z.url(),
              })
              .meta({ id: 'RunPullRequestCheck' }),
          )
          .optional(),
        checksCommit: z.string().optional(),
        checksUnavailable: z.literal(true).optional(),
        /**
         * True when the checks belong to another commit than the Run's latest pushed one: someone
         * else pushed.
         */
        checksOtherCommit: z.literal(true).optional(),
        failingChecksPreparation: z
          .object({
            state: failingChecksPreparationSchema,
            error: z.string().optional(),
          })
          .meta({ id: 'FailingChecksPreparation' })
          .optional(),
      })
      .meta({ id: 'RunPullRequest' })
      .optional(),
    deliveryRetryRequested: z.literal(true).optional(),
    resumable: z.literal(true).optional(),
    failingChecks: z.array(z.string()).optional(),
    question: runQuestionResponseSchema.optional(),
    /**
     * Everything the agent wrote is plain text. Single-Run answers only; lists leave it and
     * `question` out.
     */
    messages: z.array(runMessageResponseSchema).optional(),
  })
  .meta({ id: 'Run' });

export class RunResponseDto extends createZodDto(runResponseSchema) {}

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
      checks:
        | (
            | { unavailable: true }
            | {
                unavailable?: false;
                commit: string;
                checks: {
                  name: string;
                  state: z.infer<typeof pullRequestCheckStateSchema>;
                  durationSeconds?: number;
                  url: string;
                }[];
              }
          )
        | null;
      prepareRequestedAt: Date | null;
      prepareError: string | null;
      preparedFollowUp: boolean;
    };
    failingChecks: readonly string[];
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
          source?: z.infer<typeof followUpSourceSchema>;
          sourceComments?: { count: number; authors: string[] };
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
  followUp?: (
    { allowed: true } | { allowed: false; reason: z.infer<typeof followUpRefusalSchema> }
  ) & { openUntil?: Date; removalPending?: true },
  workerConnected?: boolean,
): RunResponse {
  const last = run.messages.at(-1);
  // The commits up to and including the pushed one are on the remote Run branch. A pushed commit
  // not in the list leaves each commit's pushed state unknown: no `pushed` field.
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
          followUp: {
            ...(followUp.allowed ? { allowed: true } : { allowed: false, reason: followUp.reason }),
            ...(followUp.openUntil ? { openUntil: followUp.openUntil.toISOString() } : {}),
            ...(followUp.removalPending ? { removalPending: true as const } : {}),
          },
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
            run.pushedCommit,
          ),
        }
      : {}),
    ...(run.deliveryRequested ? { deliveryRetryRequested: true as const } : {}),
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
                ...(message.kind === 'follow_up' && message.sourceComments !== undefined
                  ? {
                      sourceCount: message.sourceComments.count,
                      sourceAuthors: [...message.sourceComments.authors],
                    }
                  : {}),
                at: message.at.toISOString(),
              },
      ),
    ],
  };
}

export const NO_WORKER_FOR_REFRESH =
  'The agent worker is not connected, so the pull request state could not be refreshed.';

const NO_WORKER_FOR_PREPARATION =
  'The agent worker is not connected, so the logs of the failing checks could not be read.';

function toPullRequestResponse(
  pullRequest: { url: string; number: number },
  status: Parameters<typeof toRunResponse>[0]['pullRequestStatus'],
  workerConnected: boolean | undefined,
  pushedCommit: string | null,
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
    ...checksResponse(status.checks, pushedCommit),
    ...preparationResponse(status, workerConnected),
  };
}

function checksResponse(
  checks: Parameters<typeof toRunResponse>[0]['pullRequestStatus']['checks'],
  pushedCommit: string | null,
) {
  if (checks === null) return {};
  if (checks.unavailable) return { checksUnavailable: true as const };
  return {
    checksCommit: checks.commit,
    checks: checks.checks.map(({ name, state, durationSeconds, url }) => ({
      name,
      state,
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      url,
    })),
    ...(pushedCommit !== null && pushedCommit.toLowerCase() !== checks.commit.toLowerCase()
      ? { checksOtherCommit: true as const }
      : {}),
  };
}

function preparationResponse(
  status: Parameters<typeof toRunResponse>[0]['pullRequestStatus'],
  workerConnected: boolean | undefined,
) {
  if (status.prepareRequestedAt !== null) {
    // Without a connected agent worker nobody reads the logs: say so instead of waiting for ever.
    return workerConnected === false
      ? {
          failingChecksPreparation: {
            state: 'failed' as const,
            error: NO_WORKER_FOR_PREPARATION,
          },
        }
      : { failingChecksPreparation: { state: 'preparing' as const } };
  }
  if (status.prepareError !== null) {
    return { failingChecksPreparation: { state: 'failed' as const, error: status.prepareError } };
  }
  return status.preparedFollowUp ? { failingChecksPreparation: { state: 'ready' as const } } : {};
}

export function toRunListItem(run: Parameters<typeof toRunResponse>[0]): RunResponse {
  const { messages: _messages, question: _question, ...item } = toRunResponse(run);
  void _messages;
  void _question;
  return item;
}

export function withPreparedFollowUp<T extends { pullRequestStatus: object }>(
  run: T,
  preparedFollowUp: boolean,
): T & { pullRequestStatus: { preparedFollowUp: boolean } } {
  return { ...run, pullRequestStatus: { ...run.pullRequestStatus, preparedFollowUp } };
}
