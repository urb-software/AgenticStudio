import { z } from 'zod';

/**
 * The worker protocol (Issue #96): the one definition of what crosses the process boundary
 * between the API's `executions` module and `apps/agent-worker`. The API validates every
 * worker request with these schemas; the worker validates every response. Operator HTTP
 * schemas are not here: they stay in the API module (backend.md §2).
 *
 * The API's domain owns the full lists of Run states and failure codes; a test in the API
 * pins the lists below to the domain's, so the two cannot drift apart.
 */

/** The agent CLI product that carries out a Run. */
export const PROVIDERS = ['claude_code', 'codex'] as const;
export const providerSchema = z.enum(PROVIDERS);
export type Provider = z.infer<typeof providerSchema>;

/** Longest Task (the operator's instruction), in characters. */
export const TASK_MAX_LENGTH = 20_000;

/** Longest failure detail, in characters. */
export const FAILURE_DETAIL_MAX_LENGTH = 2000;

/** Every state of a Run; the API's domain owns the list (pinned by a test in the API). */
export const RUN_STATES = [
  'queued',
  'preparing',
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export const runStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof runStateSchema>;

/** Why a Run failed: fixed codes. */
export const RUN_FAILURE_CODES = [
  'provider_disabled',
  'preparation_failed',
  'agent_failed',
  'usage_limit',
  'worker_lost',
  'delivery_failed',
  'unknown',
] as const;
export const runFailureCodeSchema = z.enum(RUN_FAILURE_CODES);
export type RunFailureCode = z.infer<typeof runFailureCodeSchema>;

export const runFailureSchema = z.strictObject({
  code: runFailureCodeSchema,
  detail: z.string().max(FAILURE_DETAIL_MAX_LENGTH),
});
export type RunFailure = z.infer<typeof runFailureSchema>;

/** Identifies one agent worker process; it generates a random UUID when it starts. */
const workerIdSchema = z.uuid();

/** Longest Repository remote URL, in characters (the Repository's own limit). */
export const REMOTE_URL_MAX_LENGTH = 2048;

/**
 * The Run payload: the claim response, exactly what a Run needs and nothing else (no Studio
 * Clone path, secret references or keys). Closed, so an extra field is an error on both sides.
 */
export const runPayloadSchema = z.strictObject({
  runId: z.uuid(),
  projectId: z.uuid(),
  provider: providerSchema,
  task: z.string().min(1).max(TASK_MAX_LENGTH),
  /** The commit of the integration branch the Run starts from. */
  startCommit: z.string().min(1).max(64),
  /**
   * The Project's Repository (Issue #98): its remote URL as the operator connected it, never
   * a credential. The agent worker fetches it with the agent user's own Git credentials.
   */
  repository: z.strictObject({ remoteUrl: z.string().min(1).max(REMOTE_URL_MAX_LENGTH) }),
});
export type RunPayload = z.infer<typeof runPayloadSchema>;

/** `POST /api/worker/runs/claim` body. */
export const claimRunRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type ClaimRunRequest = z.infer<typeof claimRunRequestSchema>;

/** `POST /api/worker/runs/:runId/heartbeat` body. */
export const heartbeatRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/** The states a worker reports; every other transition belongs to the API or the operator. */
export const WORKER_REPORTED_STATES = [
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
] as const;

/** `POST /api/worker/runs/:runId/state` body: a failure exactly when the state is `failed`. */
export const reportRunStateRequestSchema = z
  .strictObject({
    workerId: workerIdSchema,
    state: z.enum(WORKER_REPORTED_STATES),
    failure: runFailureSchema.optional(),
  })
  .refine((report) => (report.state === 'failed') === (report.failure !== undefined), {
    path: ['failure'],
    message: 'A failure is reported exactly with the state failed.',
  });
export type ReportRunStateRequest = z.infer<typeof reportRunStateRequestSchema>;

/** The agent's account of one check it ran. */
export const runCheckSchema = z.strictObject({
  name: z.string().min(1).max(200),
  result: z.enum(['passed', 'failed', 'not_run']),
  detail: z.string().max(4000).optional(),
});
export type RunCheck = z.infer<typeof runCheckSchema>;

/**
 * Largest structured result, in bytes of its UTF-8 JSON (96 KiB). The API accepts JSON
 * bodies up to Express's default 100 KiB; the step report adds under 100 bytes around the
 * result, so every valid result can be reported (review finding 4 on #111).
 */
export const RUN_STEP_RESULT_MAX_BYTES = 96 * 1024;

/** Size of a value as UTF-8 JSON, as it travels in a request body. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The structured result a Run step ends with: `done`, or `needs_input` with the agent's
 * question (it pauses the Run until the operator answers). Each field has its own limit, and
 * the whole result at most {@link RUN_STEP_RESULT_MAX_BYTES}.
 */
export const runStepResultSchema = z
  .strictObject({
    outcome: z.enum(['done', 'needs_input']),
    summary: z.string().max(20_000),
    question: z.string().min(1).max(20_000).optional(),
    pullRequest: z
      .strictObject({ title: z.string().min(1).max(256), body: z.string().max(65_536) })
      .optional(),
    checks: z.array(runCheckSchema).max(100).optional(),
  })
  .refine((result) => result.outcome !== 'needs_input' || result.question !== undefined, {
    path: ['question'],
    message: 'A needs_input result carries the question.',
  })
  .refine((result) => jsonByteLength(result) <= RUN_STEP_RESULT_MAX_BYTES, {
    message: `The result is larger than ${RUN_STEP_RESULT_MAX_BYTES} bytes as JSON.`,
  });
export type RunStepResult = z.infer<typeof runStepResultSchema>;

/** The two kinds of Run step: the first execution, or one resumed after an answer. */
export const RUN_STEP_KINDS = ['start', 'resume'] as const;

/** Most commits a Working copy report lists. */
export const WORKING_COPY_COMMITS_MAX = 200;

/** Longest commit subject in a Working copy report, in characters (the worker shortens longer ones). */
export const COMMIT_SUBJECT_MAX_LENGTH = 200;

/** Largest Working copy report, in bytes of its UTF-8 JSON (64 KiB). */
export const WORKING_COPY_REPORT_MAX_BYTES = 64 * 1024;

/**
 * Largest JSON request body the API accepts (192 KiB). A maximal step report (a result of
 * {@link RUN_STEP_RESULT_MAX_BYTES}, a Working copy report of
 * {@link WORKING_COPY_REPORT_MAX_BYTES} and the envelope) stays under it.
 */
export const WORKER_REQUEST_MAX_BYTES = 192 * 1024;

/**
 * What a Run's Working copy holds after a Run step (Issue #98): the Run branch, the commits on
 * it since the start commit (oldest first, at most {@link WORKING_COPY_COMMITS_MAX}; when
 * there are more, the newest), and whether uncommitted changes remain.
 */
export const workingCopyReportSchema = z
  .strictObject({
    runBranch: z.string().min(1).max(255),
    commits: z
      .array(
        z.strictObject({
          id: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
          subject: z.string().max(COMMIT_SUBJECT_MAX_LENGTH),
        }),
      )
      .max(WORKING_COPY_COMMITS_MAX),
    hasUncommittedChanges: z.boolean(),
  })
  .refine((report) => jsonByteLength(report) <= WORKING_COPY_REPORT_MAX_BYTES, {
    message: `The Working copy report is larger than ${WORKING_COPY_REPORT_MAX_BYTES} bytes as JSON.`,
  });
export type WorkingCopyReport = z.infer<typeof workingCopyReportSchema>;

/** `POST /api/worker/runs/:runId/steps` body: the step's result and the Working copy's state. */
export const reportRunStepRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  kind: z.enum(RUN_STEP_KINDS),
  result: runStepResultSchema,
  workingCopy: workingCopyReportSchema,
});
export type ReportRunStepRequest = z.infer<typeof reportRunStepRequestSchema>;

/** One event a runner streams while a Run step executes. */
export const runnerEventSchema = z.strictObject({
  type: z.enum(['status', 'output']),
  text: z.string().max(20_000),
});
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/** Most Run ids one states request asks about. */
export const RUN_STATES_REQUEST_MAX = 500;

/**
 * `POST /api/worker/runs/states` body (Issue #98): the agent worker asks for the states of the
 * Runs it has Working copies for, to apply the retention rules.
 */
export const runStatesRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  runIds: z.array(z.uuid()).min(1).max(RUN_STATES_REQUEST_MAX),
});
export type RunStatesRequest = z.infer<typeof runStatesRequestSchema>;

/**
 * The answer: one entry per asked Run that exists (an unknown id is left out), with its state
 * and, in a final state, when it finished.
 */
export const runStatesResponseSchema = z.array(
  z.strictObject({
    runId: z.uuid(),
    state: runStateSchema,
    finishedAt: z.iso.datetime().nullable(),
  }),
);
export type RunStatesResponse = z.infer<typeof runStatesResponseSchema>;
