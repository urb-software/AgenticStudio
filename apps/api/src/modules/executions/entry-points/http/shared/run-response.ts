import {
  mergeAvailabilitySchema,
  previewAfterMergeSchema,
  pullRequestClosureSchema,
  type PreviewAfterMerge,
} from '@agentic-studio/contracts';
import type { MergeApprovalView } from '../../../application/merge-approval-view.js';
import { mergeApprovalResponseSchema, toMergeApprovalResponse } from './merge-approval-response.js';
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
  'agent_folder_unavailable',
  'agent_folder_invalid',
  'model_not_allowed',
  'model_refused',
  'skills_unusable',
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

/** The agent a Run started with, as recorded: it never changes afterwards. */
export const runAgentResponseSchema = z
  .object({
    name: z.string(),
    source: z.enum(['built_in', 'definitions']).describe('A built-in Default agent, or a folder.'),
    commit: z
      .string()
      .nullable()
      .describe(
        'The definitions Repository commit the agent was read at; null for a built-in one.',
      ),
    provider: runProviderSchema,
    model: z.string().describe('The model the definition named; `default` is the CLI own.'),
    skills: z
      .array(z.string())
      .describe(
        'The names of the skills the agent had when the Run started, at the recorded commit; empty for none.',
      ),
    instructions: z
      .string()
      .optional()
      .describe(
        'A copy of the definition instructions, plain text. Single-Run answers only; lists leave it out.',
      ),
  })
  .meta({ id: 'RunAgent' });

export const runPhaseStateSchema = z
  .enum(['pending', 'running', 'done', 'failed'])
  .describe('Whether the Phase waits, works, is done or ended without finishing.');

export const runWorkflowItemResponseSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['work', 'review', 'checkpoint']),
    agent: z.string().optional().describe('The agent a Phase names; absent for a Checkpoint.'),
    instructions: z.string().optional().describe("The Phase's own instructions, when it has any."),
    text: z.string().optional().describe('What a Checkpoint tells the operator.'),
  })
  .meta({ id: 'RunWorkflowItem' });

export const runWorkflowResponseSchema = z
  .object({
    name: z.string(),
    commit: z.string().describe('The definitions Repository commit the Workflow was read at.'),
    items: z.array(runWorkflowItemResponseSchema),
  })
  .meta({ id: 'RunWorkflow' });

export const runPhaseResponseSchema = z
  .object({
    position: z.int().min(0).describe('0 for the first Phase, then 1, 2, … in order.'),
    itemId: z
      .string()
      .nullable()
      .describe('The Workflow item the Phase came from; null for a Run started with an agent.'),
    state: runPhaseStateSchema,
    summary: z
      .string()
      .nullable()
      .describe("What the Phase's last Run step reported, plain text; null before one."),
    agent: runAgentResponseSchema.omit({ instructions: true }),
    stepsUsed: z.int().min(0).describe('The Run steps taken in the Phase.'),
  })
  .meta({ id: 'RunPhase' });

export const runResponseSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    provider: runProviderSchema,
    agent: runAgentResponseSchema,
    /** Single-Run answers only; a Run started with an agent has one Phase. */
    phases: z.array(runPhaseResponseSchema).optional(),
    workflowName: z
      .string()
      .nullable()
      .describe('The name of the Workflow the Run started with; null for a Run with an agent.'),
    /** Single-Run answers only. */
    workflow: runWorkflowResponseSchema
      .nullable()
      .optional()
      .describe('The Workflow as the Run recorded it; null for a Run started with an agent.'),
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
    /** Whether Studio can merge or close the pull request; single-Run answers only. */
    merge: mergeAvailabilitySchema.meta({ id: 'RunMergeAvailability' }).optional(),
    /** The branch the pull request merges into; single-Run answers only. */
    integrationBranch: z.string().optional(),
    /** The newest Merge approval of the Run, whatever came of it; single-Run answers only. */
    latestMergeApproval: mergeApprovalResponseSchema.optional(),
    /** The Project's Preview for the merged commit, once the latest approval was carried out; single-Run answers only. */
    previewAfterMerge: previewAfterMergeSchema.meta({ id: 'RunPreviewAfterMerge' }).optional(),
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
        ...pullRequestClosureSchema.shape,
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
    agent: {
      name: string;
      source: 'built_in' | 'definitions';
      commit: string | null;
      provider: z.infer<typeof runProviderSchema>;
      model: string;
      instructions: string;
      skills: readonly string[];
    };
    workflow: {
      name: string;
      commit: string;
      items: readonly (
        | { id: string; kind: 'work' | 'review'; agent: string; instructions?: string }
        | { id: string; kind: 'checkpoint'; text: string }
      )[];
    } | null;
    phases: readonly {
      position: number;
      itemId: string | null;
      state: z.infer<typeof runPhaseStateSchema>;
      summary: string | null;
      agent: {
        name: string;
        source: 'built_in' | 'definitions';
        commit: string | null;
        provider: z.infer<typeof runProviderSchema>;
        model: string;
        skills: readonly string[];
      };
      stepsUsed: number;
    }[];
    task: string;
    state: z.infer<typeof runStateSchema>;
    startCommit: string;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    failure: { code: z.infer<typeof runFailureCodeSchema>; detail: string } | null;
    workingCopy: {
      runBranch: string;
      commits: readonly { id: string; subject: string }[];
      hasUncommittedChanges: boolean;
    } | null;
    environmentFileSupplied: boolean;
    limits: { stepMinutes: number; maxSteps: number; waitingDays: number; maxTotalSteps: number };
    stepCount: number;
    stepsInPart: number;
    followUpCount: number;
    commitsPushed: readonly boolean[] | null;
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
      refresh: 'refreshing' | 'no_worker' | 'idle';
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
      checksOnOtherCommit: boolean;
      preparation: 'preparing' | 'no_worker' | 'failed' | 'ready' | null;
      prepareError: string | null;
      closedFromStudioAt: Date | null;
      runBranchDeletedAt: Date | null;
      runBranchDeletionFailure: string | null;
    };
    failingChecks: readonly string[];
    resumable: boolean;
    question: { text: string; options?: string[]; recommendation?: string } | null;
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
  merge?: z.infer<typeof mergeAvailabilitySchema>,
  latestMergeApproval?: MergeApprovalView | null,
  integrationBranch?: string,
  previewAfterMerge?: PreviewAfterMerge | null,
): RunResponse {
  return {
    id: run.id,
    projectId: run.projectId,
    provider: run.provider,
    agent: {
      name: run.agent.name,
      source: run.agent.source,
      commit: run.agent.commit,
      provider: run.agent.provider,
      model: run.agent.model,
      skills: [...run.agent.skills],
      instructions: run.agent.instructions,
    },
    workflowName: run.workflow?.name ?? null,
    workflow:
      run.workflow === null
        ? null
        : {
            name: run.workflow.name,
            commit: run.workflow.commit,
            items: run.workflow.items.map((item) => ({ ...item })),
          },
    phases: run.phases.map((phase) => ({
      position: phase.position,
      itemId: phase.itemId,
      state: phase.state,
      summary: phase.summary,
      agent: {
        name: phase.agent.name,
        source: phase.agent.source,
        commit: phase.agent.commit,
        provider: phase.agent.provider,
        model: phase.agent.model,
        skills: [...phase.agent.skills],
      },
      stepsUsed: phase.stepsUsed,
    })),
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
            ...(run.commitsPushed ? { pushed: run.commitsPushed[index] } : {}),
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
      usedInPart: run.stepsInPart,
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
    ...(merge ? { merge } : {}),
    ...(integrationBranch ? { integrationBranch } : {}),
    ...(latestMergeApproval
      ? { latestMergeApproval: toMergeApprovalResponse(latestMergeApproval) }
      : {}),
    ...(previewAfterMerge ? { previewAfterMerge } : {}),
    ...(run.cancelRequestedAt ? { cancelRequestedAt: run.cancelRequestedAt.toISOString() } : {}),
    ...(run.cancellation
      ? { cancellation: { by: run.cancellation.by, reason: run.cancellation.reason } }
      : {}),
    ...(run.delivery ? { delivery: run.delivery } : {}),
    ...(run.pullRequest
      ? {
          pullRequest: toPullRequestResponse(run.pullRequest, run.pullRequestStatus),
        }
      : {}),
    ...(run.deliveryRequested ? { deliveryRetryRequested: true as const } : {}),
    ...(run.resumable ? { resumable: true as const } : {}),
    ...(run.failingChecks.length > 0 ? { failingChecks: [...run.failingChecks] } : {}),
    ...(run.question
      ? {
          question: {
            text: run.question.text,
            ...(run.question.options ? { options: [...run.question.options] } : {}),
            ...(run.question.recommendation === undefined
              ? {}
              : { recommendation: run.question.recommendation }),
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
): NonNullable<RunResponse['pullRequest']> {
  const error =
    status.refreshError ?? (status.refresh === 'no_worker' ? NO_WORKER_FOR_REFRESH : null);
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
    ...(status.refresh === 'refreshing' ? { refreshing: true as const } : {}),
    ...checksResponse(status),
    ...preparationResponse(status),
    ...closureResponse(status),
  };
}

export function closureResponse(status: {
  closedFromStudioAt: Date | null;
  runBranchDeletedAt: Date | null;
  runBranchDeletionFailure: string | null;
}) {
  return {
    ...(status.closedFromStudioAt
      ? { closedFromStudioAt: status.closedFromStudioAt.toISOString() }
      : {}),
    ...(status.runBranchDeletedAt
      ? { runBranchDeletedAt: status.runBranchDeletedAt.toISOString() }
      : {}),
    ...(status.runBranchDeletionFailure
      ? { runBranchDeletionFailure: status.runBranchDeletionFailure }
      : {}),
  };
}

function checksResponse(status: Parameters<typeof toRunResponse>[0]['pullRequestStatus']) {
  const { checks } = status;
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
    ...(status.checksOnOtherCommit ? { checksOtherCommit: true as const } : {}),
  };
}

function preparationResponse(status: Parameters<typeof toRunResponse>[0]['pullRequestStatus']) {
  switch (status.preparation) {
    case null:
      return {};
    case 'preparing':
    case 'ready':
      return { failingChecksPreparation: { state: status.preparation } };
    case 'no_worker':
      return {
        failingChecksPreparation: { state: 'failed' as const, error: NO_WORKER_FOR_PREPARATION },
      };
    case 'failed':
      return {
        failingChecksPreparation: {
          state: 'failed' as const,
          error: status.prepareError!,
        },
      };
  }
}

export function toRunListItem(run: Parameters<typeof toRunResponse>[0]): RunResponse {
  const {
    messages: _messages,
    question: _question,
    phases: _phases,
    workflow: _workflow,
    ...item
  } = toRunResponse(run);
  void _messages;
  void _question;
  void _phases;
  void _workflow;
  const { instructions: _instructions, ...agent } = item.agent;
  void _instructions;
  return { ...item, agent };
}
