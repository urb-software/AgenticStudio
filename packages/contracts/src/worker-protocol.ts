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

/**
 * The Run payload: the claim response, exactly what a Run needs and nothing else (no clone
 * URL, secret references or keys). Closed, so an extra field is an error on both sides.
 */
export const runPayloadSchema = z.strictObject({
  runId: z.uuid(),
  projectId: z.uuid(),
  provider: providerSchema,
  task: z.string().min(1).max(TASK_MAX_LENGTH),
  /** The commit of the integration branch the Run starts from. */
  startCommit: z.string().min(1).max(64),
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

/** `POST /api/worker/runs/:runId/steps` body. */
export const reportRunStepRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  kind: z.enum(RUN_STEP_KINDS),
  result: runStepResultSchema,
});
export type ReportRunStepRequest = z.infer<typeof reportRunStepRequestSchema>;

/** One event a runner streams while a Run step executes. */
export const runnerEventSchema = z.strictObject({
  type: z.enum(['status', 'output']),
  text: z.string().max(20_000),
});
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/**
 * How the agent worker carries out Runs (Issue #101): `cli` starts the provider's official CLI
 * (production); `fake` uses the scripted fake runner and is allowed only in development and
 * test configurations of the worker.
 */
export const WORKER_RUNNER_MODES = ['fake', 'cli'] as const;
export type WorkerRunnerMode = (typeof WORKER_RUNNER_MODES)[number];

/**
 * `POST /api/worker/status` body (Issue #101): the worker's runner mode and which providers its
 * own configuration enables, sent when it starts and with every poll. It is a report for
 * display and for refusing hopeless starts; the worker's own check stays authoritative.
 */
export const workerStatusRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  runner: z.enum(WORKER_RUNNER_MODES),
  providers: z.strictObject({ claude_code: z.boolean(), codex: z.boolean() }),
});
export type WorkerStatusRequest = z.infer<typeof workerStatusRequestSchema>;
