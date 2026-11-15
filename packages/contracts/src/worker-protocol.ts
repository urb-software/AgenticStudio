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

/** Display names of the providers, the one list for the API and the agent worker (#101). */
export const PROVIDER_NAMES = {
  claude_code: 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<Provider, string>;

/** One on/off value per provider: the worker's switches as it reports them (#101). */
export const providerSwitchesSchema = z.strictObject({
  claude_code: z.boolean(),
  codex: z.boolean(),
} satisfies Record<Provider, z.ZodBoolean>);
export type ProviderSwitches = Readonly<z.infer<typeof providerSwitchesSchema>>;

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

/** Longest branch name, in characters (the Repository's integration branch, a Run branch). */
export const BRANCH_NAME_MAX_LENGTH = 255;

/** Longest Studio-placed path and most of them in one payload (#102). */
export const STUDIO_PATH_MAX_LENGTH = 1024;
export const STUDIO_PATHS_MAX = 50;

/**
 * What a claim hands out (Issue #102): a Run to `start` (prepare, run its first step, deliver),
 * or a `failed` Run with `delivery_failed` whose delivery the operator asked to retry: the
 * worker then only `deliver`s it from the Working copy it still has.
 */
export const RUN_PAYLOAD_KINDS = ['start', 'deliver'] as const;
export type RunPayloadKind = (typeof RUN_PAYLOAD_KINDS)[number];

/**
 * The Run payload: the claim response, exactly what a Run needs and nothing else (no Studio
 * Clone path, secret references or keys). Closed, so an extra field is an error on both sides.
 */
export const runPayloadSchema = z
  .strictObject({
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
    /** The Repository's integration branch when the Run started: the pull request's base (#102). */
    integrationBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH),
    kind: z.enum(RUN_PAYLOAD_KINDS),
    /**
     * Paths (relative to the Working copy) of files Studio places in it, e.g. the Environment file
     * (#104; none yet): never committed or pushed (#102). Studio's list is authoritative; what the
     * agent can write beside the Working copy can only add to it (review R3 of #122).
     */
    studioPaths: z.array(z.string().min(1).max(STUDIO_PATH_MAX_LENGTH)).max(STUDIO_PATHS_MAX),
    /**
     * With `deliver` only: the Run branch Studio recorded from the worker's step report. A
     * delivery retry pushes exactly this branch, never one named beside the Working copy (review
     * R1 of #122).
     */
    runBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH).optional(),
  })
  .refine((payload) => (payload.kind === 'deliver') === (payload.runBranch !== undefined), {
    path: ['runBranch'],
    message: 'A delivery claim carries the recorded Run branch, a start claim none.',
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
 * Largest JSON body of the worker's step and state reports (192 KiB); every other API route
 * keeps 100 KiB. A maximal report (a result of {@link RUN_STEP_RESULT_MAX_BYTES}, a Working
 * copy report of {@link WORKING_COPY_REPORT_MAX_BYTES} and the envelope) stays under it.
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

/** Longest pull request URL, in characters. */
export const PULL_REQUEST_URL_MAX_LENGTH = 2048;

/** The draft pull request a delivery opened or reused (Issue #102): its https URL and number. */
export const pullRequestRefSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }).max(PULL_REQUEST_URL_MAX_LENGTH),
  number: z.number().int().positive(),
});
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;

/**
 * How a successful Run was delivered (Issue #102): `none` when the Run branch has no commits
 * beyond the start commit (nothing pushed, "No changes"), or `delivered` with the draft pull
 * request. A failed delivery is the failure `delivery_failed`.
 */
export const runDeliverySchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('none') }),
  z.strictObject({ outcome: z.literal('delivered'), pullRequest: pullRequestRefSchema }),
]);
export type RunDelivery = z.infer<typeof runDeliverySchema>;

/**
 * `POST /api/worker/runs/:runId/state` body: a failure exactly when the state is `failed`. A
 * failed Run may carry its Working copy's state (Issue #98, coordinator decision), so the
 * commits of a step that failed or crashed are recorded too. A delivery outcome comes exactly
 * with `succeeded` (Issue #102), and with it the Working copy's state after the delivery
 * (a delivery retry has no step report).
 */
export const reportRunStateRequestSchema = z
  .strictObject({
    workerId: workerIdSchema,
    state: z.enum(WORKER_REPORTED_STATES),
    failure: runFailureSchema.optional(),
    delivery: runDeliverySchema.optional(),
    workingCopy: workingCopyReportSchema.optional(),
  })
  .refine((report) => (report.state === 'failed') === (report.failure !== undefined), {
    path: ['failure'],
    message: 'A failure is reported exactly with the state failed.',
  })
  .refine((report) => (report.delivery !== undefined) === (report.state === 'succeeded'), {
    path: ['delivery'],
    message: 'A delivery outcome is reported exactly with the state succeeded.',
  })
  .refine(
    (report) =>
      report.workingCopy === undefined ||
      report.state === 'failed' ||
      report.delivery !== undefined,
    {
      path: ['workingCopy'],
      message:
        'A Working copy state comes with a step report, the state failed or a delivery outcome.',
    },
  );
export type ReportRunStateRequest = z.infer<typeof reportRunStateRequestSchema>;

/** `POST /api/worker/runs/:runId/steps` body: the step's result and the Working copy's state. */
export const reportRunStepRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  kind: z.enum(RUN_STEP_KINDS),
  result: runStepResultSchema,
  workingCopy: workingCopyReportSchema,
});
export type ReportRunStepRequest = z.infer<typeof reportRunStepRequestSchema>;

/**
 * One event a runner streams while a Run step executes (Issue #99): an agent message, a tool
 * call with its command, or a tool result (output). The worker forwards each as a Run event.
 */
export const runnerEventSchema = z.strictObject({
  type: z.enum(['message', 'command', 'output']),
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
/**
 * The kinds of Run event (Issue #99): the runner's three, the markers the worker adds at the
 * start and end of each Run step, and `notice` for what Studio or the worker says about the
 * log itself (e.g. "log truncated").
 */
export const RUN_EVENT_KINDS = [
  'message',
  'command',
  'output',
  'step_started',
  'step_finished',
  'notice',
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/**
 * Largest text of one Run event, in UTF-8 bytes (16 KiB). The worker cuts longer texts before
 * sending (`truncated: true`); Studio cuts again after redaction, which can lengthen a text.
 */
export const RUN_EVENT_TEXT_MAX_BYTES = 16 * 1024;

/** Most events in one append request; the worker also splits batches by size. */
export const RUN_EVENT_BATCH_MAX = 100;

/**
 * `text` cut to at most `maxBytes` UTF-8 bytes, at a character boundary; `cut` says whether
 * anything was removed.
 */
export function cutToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, cut: false };
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so no character is split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), cut: true };
}

/** Largest seq and step index: PostgreSQL INTEGER. */
export const RUN_EVENT_SEQ_MAX = 2_147_483_647;

/** One Run event as the worker sends it; `seq` is the worker's, per Run, from 1. */
export const runEventInputSchema = z.strictObject({
  seq: z.int().min(1).max(RUN_EVENT_SEQ_MAX),
  at: z.iso.datetime(),
  /** The Run step the event belongs to: 1, 2, … */
  stepIndex: z.int().min(1).max(RUN_EVENT_SEQ_MAX),
  kind: z.enum(RUN_EVENT_KINDS),
  // A character count bounds the bytes loosely; the worker cuts to bytes before sending.
  text: z.string().max(RUN_EVENT_TEXT_MAX_BYTES),
  /** The worker already cut the text. */
  truncated: z.boolean().optional(),
});
export type RunEventInput = z.infer<typeof runEventInputSchema>;

/**
 * `POST /api/worker/runs/:runId/events` body (Issue #99): a batch in strictly increasing
 * `seq` order. Studio ignores events it already stored (an idempotent re-send) and accepts a
 * gap.
 */
export const appendRunEventsRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  events: z
    .array(runEventInputSchema)
    .min(1)
    .max(RUN_EVENT_BATCH_MAX)
    .refine((events) => events.every((event, i) => i === 0 || event.seq > events[i - 1]!.seq), {
      message: 'Events are in strictly increasing seq order.',
    }),
});
export type AppendRunEventsRequest = z.infer<typeof appendRunEventsRequestSchema>;

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
  providers: providerSwitchesSchema,
});
export type WorkerStatusRequest = z.infer<typeof workerStatusRequestSchema>;

/** What a worker reports about itself: the status request without the worker id. */
export type WorkerStatusReport = Omit<WorkerStatusRequest, 'workerId'>;
