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
  'step_limit',
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

/** Largest Environment file content, in UTF-8 bytes (64 KiB, Issue #104). */
export const ENVIRONMENT_FILE_MAX_BYTES = 64 * 1024;

/** Longest Environment file path, in characters. */
export const ENVIRONMENT_FILE_PATH_MAX_LENGTH = 255;

/** A C0 control character or DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Why `path` cannot be an Environment file path (Issue #104), or `null` when it can: a
 * relative POSIX path inside the repository, at most {@link ENVIRONMENT_FILE_PATH_MAX_LENGTH}
 * characters, with no empty, `.` or `..` segment, no leading `/`, no `\`, no control
 * character, and no `.git` segment (in any letter case). The API checks it when the operator
 * saves the path, and the agent worker again before it writes the file. Whether the path is
 * tracked in the repository is a separate check (it needs the repository).
 */
export function environmentFilePathProblem(path: string): string | null {
  if (path.length === 0) return 'Enter a path.';
  if (path.length > ENVIRONMENT_FILE_PATH_MAX_LENGTH) {
    return `The path is longer than ${ENVIRONMENT_FILE_PATH_MAX_LENGTH} characters.`;
  }
  if (CONTROL_CHARACTER.test(path)) return 'The path contains a control character.';
  if (path.includes('\\')) return 'Use forward slashes (/) in the path, not backslashes.';
  if (path.startsWith('/')) {
    return 'The path must be relative to the repository root, without a leading /.';
  }
  const segments = path.split('/');
  if (segments.includes('..')) return 'The path must stay inside the repository (no ..).';
  if (segments.includes('.')) return 'The path must not contain . segments.';
  if (segments.includes(''))
    return 'The path must not contain empty segments (// or a trailing /).';
  if (segments.some((segment) => segment.toLowerCase() === '.git')) {
    return 'The path must not be inside .git.';
  }
  return null;
}

/**
 * The Run's Environment file (Issue #104): its path in the Working copy and its content, a
 * snapshot taken when the Run was claimed. Test values only (security.md §3); the worker
 * writes it owner-only and never commits it.
 */
export const environmentFileSchema = z.strictObject({
  path: z
    .string()
    .max(ENVIRONMENT_FILE_PATH_MAX_LENGTH)
    .refine((path) => environmentFilePathProblem(path) === null, {
      message: 'The Environment file path is not a safe relative path.',
    }),
  content: z
    .string()
    .max(ENVIRONMENT_FILE_MAX_BYTES)
    .refine((content) => new TextEncoder().encode(content).length <= ENVIRONMENT_FILE_MAX_BYTES, {
      message: `The Environment file is larger than ${ENVIRONMENT_FILE_MAX_BYTES} bytes.`,
    }),
});
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;

/** Bounds of the Run limits (Issue #100), for the API's configuration and the claim payload. */
export const RUN_STEP_MINUTES_MAX = 1440;
export const RUN_MAX_STEPS_MAX = 100;

/**
 * The limits a worker enforces on a Run (Issue #100), copied onto the Run when it is started:
 * the longest a Run step may work, in minutes, and the most Run steps a Run may take. Time
 * spent waiting for the operator is not a Run step and does not count.
 */
export const runLimitsSchema = z.strictObject({
  stepMinutes: z.int().min(1).max(RUN_STEP_MINUTES_MAX),
  maxSteps: z.int().min(1).max(RUN_MAX_STEPS_MAX),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;
/** Longest branch name, in characters (the Repository's integration branch, a Run branch). */
export const BRANCH_NAME_MAX_LENGTH = 255;

/** Longest Studio-placed path and most of them in one payload (#102). */
export const STUDIO_PATH_MAX_LENGTH = 1024;
export const STUDIO_PATHS_MAX = 50;

/**
 * What a claim hands out (Issue #102): a Run to `start` (prepare, run its first step, deliver),
 * or a `failed` Run with `delivery_failed` whose delivery the operator asked to retry: the
 * worker then only `deliver`s it from the Working copy it still has. Issue #103: a Run the
 * operator answered is handed out to `resume`: the worker continues the same agent session in
 * the Working copy it kept, with the answer as the next Run step.
 */
export const RUN_PAYLOAD_KINDS = ['start', 'deliver', 'resume'] as const;
export type RunPayloadKind = (typeof RUN_PAYLOAD_KINDS)[number];

/**
 * Why a `resume` claim continues the agent session (Issue #141): the operator's answer to a
 * question (`answer`), the resume after the subscription's usage limit (`usage_limit`), or a
 * Follow-up to a finished Run (`follow_up`). The worker and the built-in agent definition word
 * the step after it; the text travels the same way for all three (`answer`).
 */
export const RESUME_REASONS = ['answer', 'usage_limit', 'follow_up'] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

/** Longest Follow-up text, in characters (Issue #141). */
export const FOLLOW_UP_MAX_LENGTH = 10_000;

/** Largest PostgreSQL INTEGER: the bound of step numbers and counters in the payload. */
const PG_INT_MAX = 2_147_483_647;

/** A commit id: SHA-1 or SHA-256, lower-case hex. */
const commitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Longest session reference a runner reports (Issue #103), e.g. the CLI's session id. */
export const SESSION_REF_MAX_LENGTH = 256;

/** Longest operator answer to an agent's question, in characters (Issue #103). */
export const ANSWER_MAX_LENGTH = 10_000;

/** Longest question text, most options, longest option and recommendation (Issue #103). */
export const QUESTION_TEXT_MAX_LENGTH = 4000;
export const QUESTION_OPTIONS_MAX = 6;
export const QUESTION_OPTION_MAX_LENGTH = 200;

/** An opaque reference to the agent's session, as the runner reported it (Issue #103). */
const sessionRefSchema = z.string().min(1).max(SESSION_REF_MAX_LENGTH);

/**
 * The Run payload: the claim response, exactly what a Run needs and nothing else (no Studio
 * Clone path, secret references or keys; the Environment file's content is the one secret
 * value, Issue #104). Closed, so an extra field is an error on both sides.
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
     * (#104): never committed or pushed (#102). Studio's list is authoritative; what the
     * agent can write beside the Working copy can only add to it (review R3 of #122).
     */
    studioPaths: z.array(z.string().min(1).max(STUDIO_PATH_MAX_LENGTH)).max(STUDIO_PATHS_MAX),
    /**
     * With `deliver` and `resume` only: the Run branch Studio recorded from the worker's step
     * report. A delivery retry pushes exactly this branch, never one named beside the Working
     * copy (review R1 of #122); a resumed Run delivers it the same way (Issue #103).
     */
    runBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH).optional(),
    /** With `resume` only (Issue #103): the agent session to continue, as the runner reported it. */
    sessionRef: sessionRefSchema.optional(),
    /**
     * With `resume` only: the operator's message the session continues with: the answer to the
     * agent's question, "Continue where you stopped." after the usage limit, or the Follow-up
     * text (Issue #141), as `resumeReason` says.
     */
    answer: z.string().min(1).max(Math.max(ANSWER_MAX_LENGTH, FOLLOW_UP_MAX_LENGTH)).optional(),
    /** With `resume` only (Issue #141): why the session continues. */
    resumeReason: z.enum(RESUME_REASONS).optional(),
    /**
     * Issue #141: the number of the Follow-up the Run is working on (1, 2, …), present while the
     * Run's current part is a Follow-up (also when it resumes after a question inside it). The
     * worker marks the Follow-up's start and end in the log.
     */
    followUpNumber: z.int().min(1).max(PG_INT_MAX).optional(),
    /**
     * Issue #141: how many Run steps the Run had taken when its current part began (the first
     * part: 0; a Follow-up: the steps before it). Each part gets `limits.maxSteps` Run steps, so
     * the worker refuses a step beyond `stepsBeforePart + limits.maxSteps`. Absent: 0.
     */
    stepsBeforePart: z.int().min(0).max(PG_INT_MAX).optional(),
    /**
     * With `resume` and `deliver` (Issue #141): the number of the draft pull request Studio
     * recorded for the Run. A delivery updates exactly this pull request (never a second one) and
     * fails when it is no longer open.
     */
    pullRequestNumber: z.int().positive().max(PG_INT_MAX).optional(),
    /**
     * With `resume` and `deliver`: the seq of the Run's next event, one past the last Studio
     * stored, so the worker's events are not dropped as duplicates (Issue #99 note on #103). A
     * start claim has none: its log starts at 1.
     */
    nextSeq: z.int().min(1).max(2_147_483_647).optional(),
    /**
     * With `start`, or with a `resume` that replaces it (Issue #141): the Project's Environment
     * file as it was when the Run was claimed (Issue #104), only for the worker that claimed the
     * Run; its path is in `studioPaths`. Never logged.
     */
    environmentFile: environmentFileSchema.optional(),
    /**
     * With `resume` only (Issue #141): Studio took a new snapshot of the Project's Environment
     * file for this part of the Run (a Follow-up, or a usage-limit resume inside one). The worker
     * removes every Studio-placed file (`studioPaths`) from the Working copy, then writes
     * `environmentFile` when there is one; without it the Run goes on without the file.
     */
    replaceEnvironmentFile: z.literal(true).optional(),
    /** The limits in force for this Run (Issue #100). */
    limits: runLimitsSchema,
    /**
     * How many Run steps the Run has already taken (Issue #100): the next one is
     * `completedSteps + 1`, and the worker refuses to start it beyond `limits.maxSteps`.
     */
    completedSteps: z.int().min(0),
  })
  .refine((payload) => (payload.kind !== 'start') === (payload.runBranch !== undefined), {
    path: ['runBranch'],
    message: 'A delivery or resume claim carries the recorded Run branch, a start claim none.',
  })
  .refine(
    (payload) =>
      [payload.sessionRef, payload.answer, payload.resumeReason].every(
        (field) => (field !== undefined) === (payload.kind === 'resume'),
      ) && (payload.nextSeq !== undefined) === (payload.kind !== 'start'),
    {
      path: ['kind'],
      message:
        'A resume claim carries the session reference, the answer and the resume reason, a resume or delivery claim the next seq; a start claim none of them.',
    },
  )
  .refine(
    (payload) =>
      (payload.followUpNumber === undefined || payload.kind === 'resume') &&
      (payload.resumeReason !== 'follow_up' || payload.followUpNumber !== undefined) &&
      (payload.answer === undefined ||
        payload.answer.length <=
          (payload.resumeReason === 'follow_up' ? FOLLOW_UP_MAX_LENGTH : ANSWER_MAX_LENGTH)),
    {
      path: ['followUpNumber'],
      message:
        'A Follow-up number comes with a resume claim only, and always with the resume reason follow_up.',
    },
  )
  .refine((payload) => payload.pullRequestNumber === undefined || payload.kind !== 'start', {
    path: ['pullRequestNumber'],
    message: 'A recorded pull request comes with a resume or delivery claim only.',
  })
  .refine(
    (payload) =>
      (payload.replaceEnvironmentFile === undefined || payload.kind === 'resume') &&
      (payload.environmentFile === undefined ||
        ((payload.kind === 'start' || payload.replaceEnvironmentFile === true) &&
          payload.studioPaths.includes(payload.environmentFile.path))),
    {
      path: ['environmentFile'],
      message:
        'An Environment file comes with a start claim or a resume that replaces it, its path among the studioPaths.',
    },
  );
export type RunPayload = z.infer<typeof runPayloadSchema>;

/**
 * Problem `type`s of the worker routes the agent worker acts on (review of #121). Only these
 * (and 404) mean the worker no longer holds the Run and must abandon it; any other refusal,
 * e.g. `illegal-run-transition`, is logged and the Run goes on. Pinned to the API's list by a
 * test in the API.
 */
export const WORKER_PROBLEM_TYPES = {
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  stepLimitReached: 'urn:agentic-studio:problem:step-limit-reached',
} as const;

/** `POST /api/worker/runs/claim` body. */
export const claimRunRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type ClaimRunRequest = z.infer<typeof claimRunRequestSchema>;

/** `POST /api/worker/runs/:runId/heartbeat` body. */
export const heartbeatRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/**
 * `POST /api/worker/runs/:runId/heartbeat` answer (Issue #100): whether the operator asked to
 * cancel the Run. The worker then stops the Run step and reports `cancelled`.
 */
export const heartbeatResponseSchema = z.strictObject({ cancelRequested: z.boolean() });
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

/**
 * The states a worker reports; every other transition belongs to the API or the operator.
 * `cancelled` confirms an operator's cancel after the Run step was stopped, `timed_out` a Run
 * step stopped at its time limit (Issue #100).
 */
export const WORKER_REPORTED_STATES = [
  'running',
  'waiting_for_operator',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;

/** The reported end states that may carry the Working copy's state (it is kept for inspection). */
const STOPPED_STATES: readonly string[] = ['failed', 'cancelled', 'timed_out'];

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
 * The agent's question to the operator (Issue #103): its text, the options it offers (at most
 * six) and the one it recommends. All of it is the agent's text: shown as plain text only.
 */
export const runQuestionSchema = z.strictObject({
  text: z.string().min(1).max(QUESTION_TEXT_MAX_LENGTH),
  options: z
    .array(z.string().min(1).max(QUESTION_OPTION_MAX_LENGTH))
    .min(1)
    .max(QUESTION_OPTIONS_MAX)
    .optional(),
  recommendation: z.string().min(1).max(QUESTION_OPTION_MAX_LENGTH).optional(),
});
export type RunQuestion = z.infer<typeof runQuestionSchema>;

/**
 * The structured result a Run step ends with: `done`, or `needs_input` with the agent's
 * question (it pauses the Run until the operator answers) and the reference of the agent's
 * session, which the answer resumes (Issue #103). Each field has its own limit, and the whole
 * result at most {@link RUN_STEP_RESULT_MAX_BYTES}.
 */
export const runStepResultSchema = z
  .strictObject({
    outcome: z.enum(['done', 'needs_input']),
    summary: z.string().max(20_000),
    question: runQuestionSchema.optional(),
    /** The agent session the step ran in (Issue #103); required with `needs_input`. */
    sessionRef: sessionRefSchema.optional(),
    pullRequest: z
      .strictObject({ title: z.string().min(1).max(256), body: z.string().max(65_536) })
      .optional(),
    checks: z.array(runCheckSchema).max(100).optional(),
  })
  .refine((result) => result.outcome !== 'needs_input' || result.question !== undefined, {
    path: ['question'],
    message: 'A needs_input result carries the question.',
  })
  .refine((result) => result.outcome !== 'needs_input' || result.sessionRef !== undefined, {
    path: ['sessionRef'],
    message: 'A needs_input result carries the session reference its answer resumes.',
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
          id: commitIdSchema,
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

/**
 * A pull request's page on github.com (Issue #115): `https://github.com/<owner>/<repo>/pull/<n>`,
 * without credentials, port, query or fragment. Delivery targets GitHub only.
 */
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/?#@:]+\/[^/?#@:]+\/pull\/[1-9]\d*$/;

/**
 * The draft pull request a delivery opened or reused (Issue #102): its URL on github.com
 * (Issue #115) and number.
 */
export const pullRequestRefSchema = z.strictObject({
  url: z
    .url({ protocol: /^https$/, hostname: /^github\.com$/ })
    .max(PULL_REQUEST_URL_MAX_LENGTH)
    .regex(GITHUB_PULL_REQUEST_URL),
  number: z.number().int().positive(),
});
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;

/**
 * How a successful Run was delivered (Issue #102): `none` when the Run branch has no commits
 * beyond the start commit (nothing pushed, "No changes"), or `delivered` with the draft pull
 * request. A failed delivery is the failure `delivery_failed`.
 */
export const runDeliverySchema = z.discriminatedUnion('outcome', [
  z
    .strictObject({
      outcome: z.literal('none'),
      /**
       * Only with `cancelled` (review of #124): the cancel arrived during the delivery, the Run
       * branch was pushed, but no pull request was opened.
       */
      branchPushed: z.literal(true).optional(),
      /** With `branchPushed` (Issue #141): the commit the push left the remote Run branch at. */
      pushedCommit: commitIdSchema.optional(),
    })
    .refine((delivery) => delivery.pushedCommit === undefined || delivery.branchPushed === true, {
      path: ['pushedCommit'],
      message: 'A pushed commit comes only with a pushed branch.',
    }),
  z.strictObject({
    outcome: z.literal('delivered'),
    pullRequest: pullRequestRefSchema,
    /**
     * Issue #141: the commit the push left the remote Run branch at; the commits up to and
     * including it are pushed, later ones exist only in the Working copy.
     */
    pushedCommit: commitIdSchema.optional(),
  }),
]);
export type RunDelivery = z.infer<typeof runDeliverySchema>;

/**
 * `POST /api/worker/runs/:runId/state` body: a failure exactly when the state is `failed`. A
 * failed Run may carry its Working copy's state (Issue #98, coordinator decision), so the
 * commits of a step that failed or crashed are recorded too. A delivery outcome comes exactly
 * with `succeeded` (Issue #102), and with it the Working copy's state after the delivery
 * (a delivery retry has no step report). A cancelled or timed-out Run may carry its Working
 * copy's state too (Issue #100).
 */
export const reportRunStateRequestSchema = z
  .strictObject({
    workerId: workerIdSchema,
    state: z.enum(WORKER_REPORTED_STATES),
    failure: runFailureSchema.optional(),
    delivery: runDeliverySchema.optional(),
    workingCopy: workingCopyReportSchema.optional(),
    /**
     * With `failed` / `usage_limit` only (Issue #105): the agent session the step ran in, so the
     * operator can resume the Run once the limit resets.
     */
    sessionRef: sessionRefSchema.optional(),
    /**
     * With `failed` / `delivery_failed` only (Issue #141): the delivery pushed the Run branch to
     * this commit before it failed (e.g. updating the pull request was refused), so Studio still
     * knows which commits are pushed.
     */
    pushedCommit: commitIdSchema.optional(),
  })
  .refine((report) => (report.state === 'failed') === (report.failure !== undefined), {
    path: ['failure'],
    message: 'A failure is reported exactly with the state failed.',
  })
  .refine(
    (report) =>
      report.delivery?.outcome !== 'none' ||
      report.delivery.branchPushed === undefined ||
      report.state === 'cancelled',
    {
      path: ['delivery', 'branchPushed'],
      message: 'A pushed branch without a pull request is reported only with cancelled.',
    },
  )
  .refine(
    (report) =>
      report.state === 'succeeded'
        ? report.delivery !== undefined
        : report.delivery === undefined || report.state === 'cancelled',
    {
      path: ['delivery'],
      message:
        'A delivery outcome is reported with the state succeeded, or with cancelled when the ' +
        'cancel arrived during the delivery (review of #121).',
    },
  )
  .refine((report) => report.sessionRef === undefined || report.failure?.code === 'usage_limit', {
    path: ['sessionRef'],
    message: 'A session reference comes only with the failure usage_limit (Issue #105).',
  })
  .refine(
    (report) => report.pushedCommit === undefined || report.failure?.code === 'delivery_failed',
    {
      path: ['pushedCommit'],
      message:
        'A pushed commit on its own comes only with the failure delivery_failed (Issue #141).',
    },
  )
  .refine(
    (report) =>
      report.workingCopy === undefined ||
      STOPPED_STATES.includes(report.state) ||
      report.delivery !== undefined,
    {
      path: ['workingCopy'],
      message:
        'A Working copy state comes with a step report, the state failed, cancelled or timed_out, or a delivery outcome.',
    },
  );
export type ReportRunStateRequest = z.infer<typeof reportRunStateRequestSchema>;

/**
 * `POST /api/worker/runs/:runId/steps` body: the step's number and kind, its result and the
 * Working copy's state.
 */
export const reportRunStepRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  /**
   * The Run step's number, 1, 2, … (review of #121): a retried report of a step Studio already
   * stored is recognised by it and changes nothing.
   */
  index: z.int().min(1).max(2_147_483_647),
  kind: z.enum(RUN_STEP_KINDS),
  result: runStepResultSchema,
  workingCopy: workingCopyReportSchema,
});
export type ReportRunStepRequest = z.infer<typeof reportRunStepRequestSchema>;

/**
 * One event a runner streams while a Run step executes (Issue #99): an agent message, a tool
 * call with its command, or a tool result (output). Issue #105: or a `notice`, what the runner
 * says about the step itself (a denied tool call, a skipped instruction import). The worker
 * forwards each as a Run event.
 */
export const runnerEventSchema = z.strictObject({
  type: z.enum(['message', 'command', 'output', 'notice']),
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
  /**
   * Issue #141: Runs whose Working copies this worker's retention removed and has not reported
   * yet. Studio records the removal, so the Run page says a Follow-up is no longer possible.
   */
  removedRunIds: z.array(z.uuid()).max(RUN_STATES_REQUEST_MAX).optional(),
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

/** Longest reason a worker gives for an unavailable provider (Issue #105). */
export const PROVIDER_REASON_MAX_LENGTH = 500;

const providerReasonSchema = z.string().min(1).max(PROVIDER_REASON_MAX_LENGTH);

/**
 * `POST /api/worker/status` body (Issue #101): the worker's runner mode and which providers its
 * own configuration enables, sent when it starts and with every poll. It is a report for
 * display and for refusing hopeless starts; the worker's own check stays authoritative.
 */
export const workerStatusRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  runner: z.enum(WORKER_RUNNER_MODES),
  providers: providerSwitchesSchema,
  /**
   * Issue #105: why a provider whose switch is on cannot run on this worker (e.g. its CLI is
   * missing or of an unsupported version). The switches keep their meaning; a reason makes the
   * provider unavailable on top of them. Text for the operator, never a path or a credential.
   */
  providerReasons: z
    .strictObject({
      claude_code: providerReasonSchema.optional(),
      codex: providerReasonSchema.optional(),
    } satisfies Record<Provider, z.ZodOptional<z.ZodString>>)
    .optional(),
});
export type WorkerStatusRequest = z.infer<typeof workerStatusRequestSchema>;

/** What a worker reports about itself: the status request without the worker id. */
export type WorkerStatusReport = Omit<WorkerStatusRequest, 'workerId'>;
