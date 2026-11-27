import { z } from 'zod';
import {
  AGENT_INSTRUCTIONS_MAX_BYTES,
  PROVIDERS,
  type Provider,
  RUN_SKILLS_MAX_BYTES,
} from './providers.js';

export { PROVIDERS, type Provider, RUN_SKILLS_MAX_BYTES };

/**
 * The Studio/agent-worker wire protocol: the API validates every worker request, the worker every
 * response, and a test in the API pins the Run states and failure codes to the domain's.
 */

export const providerSchema = z.enum(PROVIDERS);

/** Display names of the providers, the one list for the API and the agent worker. */
export const PROVIDER_NAMES = {
  claude_code: 'Claude Code',
  codex: 'Codex',
} as const satisfies Record<Provider, string>;

/** One on/off value per provider, as the worker reports its switches. */
export const providerSwitchesSchema = z.strictObject({
  claude_code: z.boolean(),
  codex: z.boolean(),
} satisfies Record<Provider, z.ZodBoolean>);
export type ProviderSwitches = Readonly<z.infer<typeof providerSwitchesSchema>>;

/** Longest Task (the operator's instruction), in characters. */
export const TASK_MAX_LENGTH = 20_000;

/** Longest failure detail, in characters. */
export const FAILURE_DETAIL_MAX_LENGTH = 2000;

/** Every state of a Run; the API's domain owns the list. */
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
  'agent_folder_unavailable',
  'agent_folder_invalid',
  'model_not_allowed',
  'model_refused',
  'skills_unusable',
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

/** Largest Environment file content, in UTF-8 bytes (64 KiB). */
export const ENVIRONMENT_FILE_MAX_BYTES = 64 * 1024;

/** Longest Environment file path, in characters. */
export const ENVIRONMENT_FILE_PATH_MAX_LENGTH = 255;

/** A C0 control character or DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Why `path` cannot be an Environment file path (relative, inside the repository, no `.git`
 * segment), or `null` when it can. The API checks it on save and the worker again before it
 * writes the file; whether the path is tracked in the repository is a separate check.
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
 * The Run's Environment file, a snapshot taken at claim. Test values only (security.md §3); the
 * worker writes it owner-only and never commits it.
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

/** Bounds of the Run limits, for the API's configuration and the claim payload. */
export const RUN_STEP_MINUTES_MAX = 1440;
export const RUN_MAX_STEPS_MAX = 100;

/**
 * The limits a worker enforces on a Run: the longest a Run step may work, in minutes, and the
 * most Run steps. Time waiting for the operator is not a Run step and does not count.
 */
export const runLimitsSchema = z.strictObject({
  stepMinutes: z.int().min(1).max(RUN_STEP_MINUTES_MAX),
  maxSteps: z.int().min(1).max(RUN_MAX_STEPS_MAX),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;
/** Longest branch name, in characters (the Repository's integration branch, a Run branch). */
export const BRANCH_NAME_MAX_LENGTH = 255;

/** Longest Studio-placed path and most of them in one payload. */
export const STUDIO_PATH_MAX_LENGTH = 1024;
export const STUDIO_PATHS_MAX = 50;

/**
 * What a claim hands out: a Run to `start`, a `delivery_failed` Run to `deliver` again from the
 * Working copy it kept, an answered Run to `resume` in the same agent session, or a Workflow
 * Run's next Phase (`next_phase`) in the Working copy the Phase before left.
 */
export const RUN_PAYLOAD_KINDS = ['start', 'deliver', 'resume', 'next_phase'] as const;
export type RunPayloadKind = (typeof RUN_PAYLOAD_KINDS)[number];

/**
 * Why a `resume` claim continues the agent session: an operator `answer`, the `usage_limit`
 * resume, a `follow_up` or a `bring_up_to_date` request. The text travels as `answer` for all.
 */
export const RESUME_REASONS = ['answer', 'usage_limit', 'follow_up', 'bring_up_to_date'] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

/**
 * The text of a bring-up-to-date claim without an operator note; the worker words the agent's
 * instruction itself and leaves this text out.
 */
export const BRING_UP_TO_DATE_DEFAULT_TEXT = 'Bring the Run branch up to date.';

/** Longest Follow-up text, in characters. */
export const FOLLOW_UP_MAX_LENGTH = 10_000;

/** Largest PostgreSQL INTEGER: the bound of step numbers and counters in the payload. */
const PG_INT_MAX = 2_147_483_647;

/** A commit id: SHA-1 or SHA-256, lower-case hex. */
const commitIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** Longest session reference a runner reports, e.g. the CLI's session id. */
export const SESSION_REF_MAX_LENGTH = 256;

/** Longest operator answer to an agent's question, in characters. */
export const ANSWER_MAX_LENGTH = 10_000;

/** Longest question text, most options, longest option and recommendation. */
export const QUESTION_TEXT_MAX_LENGTH = 4000;
export const QUESTION_OPTIONS_MAX = 6;
export const QUESTION_OPTION_MAX_LENGTH = 200;

/** A Git object id: a full SHA-1 or SHA-256 in lowercase hex. */
const objectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * Where a Run's diffs stand: tree and commit of the latest result and of the one before it, and
 * the pushed Run branch tip. Studio keeps it and hands it back with a resume or delivery claim,
 * so it never lives where the agent can write it.
 */
export const runDiffStateSchema = z.strictObject({
  resultTree: objectIdSchema,
  resultCommit: objectIdSchema,
  previousTree: objectIdSchema,
  previousCommit: objectIdSchema,
  pushedCommit: objectIdSchema.optional(),
});
export type RunDiffState = z.infer<typeof runDiffStateSchema>;

/** Longest agent name, in characters. */
export const RUN_AGENT_NAME_MAX_LENGTH = 64;

/** A usable agent name: lower-case letters, digits and `-`, up to {@link RUN_AGENT_NAME_MAX_LENGTH}. */
export const RUN_AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Text bounded in UTF-8 bytes, which the schema's character count alone does not give. */
const withinBytes = (limit: number) => (text: string) =>
  new TextEncoder().encode(text).length <= limit;

/**
 * Studio's base rules as a claim carries them: the version for the Run's log and the text every
 * real runner gives its agent first. The worker has no copy of its own.
 */
export const baseRulesPayloadSchema = z.strictObject({
  version: z.string().min(1).max(64),
  text: z.string().min(1).refine(withinBytes(AGENT_INSTRUCTIONS_MAX_BYTES)),
});
export type BaseRulesPayload = z.infer<typeof baseRulesPayloadSchema>;

/**
 * The agent a Run recorded at start, handed back with every claim of the Run: Studio never
 * resolves the agent again, so a definition that changed or was removed since changes nothing.
 * The instructions are untrusted text, like the Task.
 */
export const runAgentPayloadSchema = z
  .strictObject({
    name: z.string().regex(RUN_AGENT_NAME_PATTERN),
    source: z.enum(['built_in', 'definitions']),
    /** The definitions Repository commit the agent was read at; null for a built-in agent. */
    commit: commitIdSchema.nullable(),
    provider: providerSchema,
    /** One of the Provider's models (PROVIDER_MODELS); the runners pass it to the CLI, `default` as no option. */
    model: z.string().min(1).max(64),
    instructions: z.string().refine(withinBytes(AGENT_INSTRUCTIONS_MAX_BYTES), {
      message: 'The instructions are longer than the definitions limit in bytes.',
    }),
  })
  .refine((agent) => (agent.source === 'definitions') === (agent.commit !== null), {
    path: ['commit'],
    message: 'A definitions agent carries its commit, a built-in agent none.',
  });
export type RunAgentPayload = z.infer<typeof runAgentPayloadSchema>;

/** Most skills a Run records: the limit of the definitions package, repeated here for the wire. */
export const RUN_SKILLS_MAX = 20;

/** A skill name: the rule of agent names, which skill folders follow too. */
const skillNameSchema = z.string().regex(RUN_AGENT_NAME_PATTERN);

/** What a claim says of one skill of the Run: its name and the description of its entry file. */
export const runSkillSummarySchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().min(1).max(1024),
});
export type RunSkillSummary = z.infer<typeof runSkillSummarySchema>;

/** Most Phases a Run of a Workflow has: the Workflow format's limit, repeated here for the wire. */
export const RUN_PHASES_MAX = 12;

/** Longest hand-over to a Phase after the first, in UTF-8 bytes; the worker cuts it with a note. */
export const PHASE_HAND_OVER_MAX_BYTES = 8 * 1024;

/** Longest Phase instructions of a Workflow, in UTF-8 bytes: the Workflow format's limit. */
export const PHASE_INSTRUCTIONS_MAX_BYTES = 2 * 1024;

/**
 * The Phase of a Workflow Run a claim is for; a Run started with an agent has none. The text of
 * `instructions` and `previous.summary` is untrusted, like the Task.
 */
export const runPhasePayloadSchema = z.strictObject({
  /** 0 for the first Phase. */
  position: z
    .int()
    .min(0)
    .max(RUN_PHASES_MAX - 1),
  itemId: z.string().min(1).max(64),
  /** How many Phases the Run has. */
  count: z.int().min(1).max(RUN_PHASES_MAX),
  /** Studio decided that this Phase's `done` ends the Workflow: the Run delivers after it. */
  final: z.boolean(),
  /** The Workflow item's own instructions for this Phase, after the agent's. */
  instructions: z
    .string()
    .refine(withinBytes(PHASE_INSTRUCTIONS_MAX_BYTES), {
      message: 'The Phase instructions are longer than the Workflow format allows.',
    })
    .optional(),
  /** For a Phase after the first: what the Phase before it reported. */
  previous: z
    .strictObject({
      itemId: z.string().min(1).max(64),
      agent: z.string().regex(RUN_AGENT_NAME_PATTERN),
      summary: z.string().max(20_000),
    })
    .optional(),
});
export type RunPhasePayload = z.infer<typeof runPhasePayloadSchema>;

/** An opaque reference to the agent's session, as the runner reported it. */
const sessionRefSchema = z.string().min(1).max(SESSION_REF_MAX_LENGTH);

/**
 * The Run payload (the claim response): exactly what a Run needs, no Studio Clone path, secret
 * references or keys; the Environment file's content is the one secret value. Closed.
 */
export const runPayloadSchema = z
  .strictObject({
    runId: z.uuid(),
    projectId: z.uuid(),
    provider: providerSchema,
    /** Every claim of the Run carries the base rules and the Run's recorded agent. */
    baseRules: baseRulesPayloadSchema,
    agent: runAgentPayloadSchema,
    /**
     * The skills the Run recorded, with the description judged at the recorded commit; empty
     * means none. Their files come from the skills route, never from the claim.
     */
    skills: z.array(runSkillSummarySchema).max(RUN_SKILLS_MAX),
    task: z.string().min(1).max(TASK_MAX_LENGTH),
    /** The commit of the integration branch the Run starts from. */
    startCommit: z.string().min(1).max(64),
    /**
     * The Repository's remote URL as the operator connected it, never a credential; the worker
     * fetches it with the agent user's own Git credentials.
     */
    repository: z.strictObject({ remoteUrl: z.string().min(1).max(REMOTE_URL_MAX_LENGTH) }),
    /** The Repository's integration branch when the Run started: the pull request's base. */
    integrationBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH),
    kind: z.enum(RUN_PAYLOAD_KINDS),
    /** The Phase of a Workflow Run this claim is for; absent for a Run started with an agent. */
    phase: runPhasePayloadSchema.optional(),
    /**
     * Paths (relative to the Working copy) of files Studio places in it, never committed or
     * pushed. Studio's list is authoritative: what the agent writes beside the Working copy can
     * only add to it.
     */
    studioPaths: z.array(z.string().min(1).max(STUDIO_PATH_MAX_LENGTH)).max(STUDIO_PATHS_MAX),
    /**
     * With `deliver` and `resume`: the Run branch Studio recorded from the step report. A delivery
     * pushes exactly this branch, never one named beside the Working copy.
     */
    runBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH).optional(),
    /** With `resume`: the agent session to continue, as the runner reported it. */
    sessionRef: sessionRefSchema.optional(),
    /**
     * With `resume`: the operator's message the session continues with, as `resumeReason` says:
     * the answer, "Continue where you stopped." or the Follow-up text.
     */
    answer: z.string().min(1).max(Math.max(ANSWER_MAX_LENGTH, FOLLOW_UP_MAX_LENGTH)).optional(),
    /** With `resume`: why the session continues. */
    resumeReason: z.enum(RESUME_REASONS).optional(),
    /**
     * The number of the Follow-up the Run's current part is (also on a resume after a question
     * inside it); the worker marks its start and end in the log.
     */
    followUpNumber: z.int().min(1).max(PG_INT_MAX).optional(),
    /**
     * With `resume`: the current part is a request to bring the Run branch up to date (also after
     * a question or the usage limit inside it). The worker completes a merge left open at the
     * end of the step, or aborts it when the part does not end well.
     */
    bringUpToDate: z.literal(true).optional(),
    /**
     * With `bringUpToDate`, once the merge started: the Run branch commit just before it and the
     * integration commit being merged, so a later claim knows what to reset to when the part
     * fails and which merge to expect.
     */
    updateBase: commitIdSchema.optional(),
    updateTip: commitIdSchema.optional(),
    /**
     * With `resume` and `deliver`: the integration commit the Run branch last merged. The Run's
     * own changes are counted from it, as the pull request counts from the merge base; absent:
     * from the start commit.
     */
    mergedIntegrationCommit: commitIdSchema.optional(),
    /**
     * With a `resume` claim that starts a new part: an earlier bring-up-to-date part began a merge
     * and never succeeded, so its merge commit may remain. The worker resets the Run branch to
     * `baseCommit` first, unless something past it was pushed (`pushedCommit`).
     */
    pendingUpdate: z
      .strictObject({ baseCommit: commitIdSchema, pushedCommit: commitIdSchema.optional() })
      .optional(),
    /**
     * How many Run steps the Run had taken when its current part began; each part gets
     * `limits.maxSteps`, so the worker refuses a step beyond `stepsBeforePart + limits.maxSteps`.
     * Absent: 0.
     */
    stepsBeforePart: z.int().min(0).max(PG_INT_MAX).optional(),
    /**
     * With `resume` and `deliver`: the draft pull request Studio recorded. A delivery updates
     * exactly this one (never a second) and fails when it is no longer open.
     */
    pullRequestNumber: z.int().positive().max(PG_INT_MAX).optional(),
    /**
     * With `resume` and `deliver`: the seq of the Run's next event, so the worker's events are
     * not dropped as duplicates. A start claim has none: its log starts at 1.
     */
    nextSeq: z.int().min(1).max(2_147_483_647).optional(),
    /**
     * With `start`, or a `resume` that replaces it: the Environment file as of the claim, only for
     * the worker that claimed the Run; its path is in `studioPaths`. Never logged.
     */
    environmentFile: environmentFileSchema.optional(),
    /**
     * With `resume`: Studio took a new Environment file snapshot for this part. The worker removes
     * every Studio-placed file from the Working copy, then writes `environmentFile` if present.
     */
    replaceEnvironmentFile: z.literal(true).optional(),
    /** The limits in force for this Run. */
    limits: runLimitsSchema,
    /** With `resume` and `deliver`, once diffs were reported: where they stand. */
    diffState: runDiffStateSchema.optional(),
    /**
     * How many Run steps the Run has taken; the worker refuses to start the next one beyond
     * `limits.maxSteps`.
     */
    completedSteps: z.int().min(0),
  })
  .refine((payload) => payload.agent.provider === payload.provider, {
    path: ['agent'],
    message: 'The provider of a Run is the provider of its agent.',
  })
  .refine((payload) => (payload.kind !== 'start') === (payload.runBranch !== undefined), {
    path: ['runBranch'],
    message: 'A delivery or resume claim carries the recorded Run branch, a start claim none.',
  })
  .refine(
    (payload) => {
      const resumed = [payload.sessionRef, payload.answer, payload.resumeReason].map(
        (field) => field !== undefined,
      );
      // A next-Phase claim resumes the Phase's session only in a Follow-up round.
      const consistent =
        payload.kind === 'resume'
          ? resumed.every(Boolean)
          : payload.kind === 'next_phase'
            ? resumed.every(Boolean) || !resumed.some(Boolean)
            : !resumed.some(Boolean);
      return consistent && (payload.nextSeq !== undefined) === (payload.kind !== 'start');
    },
    {
      path: ['kind'],
      message:
        'A resume claim carries the session reference, the answer and the resume reason, a next-Phase claim all or none of them, a resume, next-Phase or delivery claim the next seq; a start claim none of them.',
    },
  )
  .refine(
    (payload) =>
      payload.phase === undefined
        ? payload.kind !== 'next_phase'
        : payload.kind !== 'deliver' && payload.phase.position < payload.phase.count,
    {
      path: ['phase'],
      message:
        'A next-Phase claim carries its Phase, a delivery claim none, and a Phase lies within the Run count.',
    },
  )
  .refine(
    (payload) =>
      (payload.followUpNumber === undefined ||
        payload.kind === 'resume' ||
        payload.kind === 'next_phase') &&
      ((payload.resumeReason !== 'follow_up' && payload.resumeReason !== 'bring_up_to_date') ||
        payload.followUpNumber !== undefined) &&
      (payload.answer === undefined ||
        payload.answer.length <=
          (payload.resumeReason === 'follow_up' || payload.resumeReason === 'bring_up_to_date'
            ? FOLLOW_UP_MAX_LENGTH
            : ANSWER_MAX_LENGTH)),
    {
      path: ['followUpNumber'],
      message:
        'A Follow-up number comes with a resume or next-Phase claim only, and always with the resume reason follow_up or bring_up_to_date.',
    },
  )
  .refine(
    (payload) =>
      (payload.updateBase === undefined && payload.updateTip === undefined) ||
      payload.bringUpToDate === true,
    {
      path: ['updateBase'],
      message: 'The merge start commits come only with the bring-up-to-date flag.',
    },
  )
  .refine((payload) => payload.pendingUpdate === undefined || payload.kind === 'resume', {
    path: ['pendingUpdate'],
    message: 'A pending update comes with a resume claim only.',
  })
  .refine((payload) => payload.mergedIntegrationCommit === undefined || payload.kind !== 'start', {
    path: ['mergedIntegrationCommit'],
    message: 'A start claim has merged nothing yet.',
  })
  .refine(
    (payload) =>
      (payload.bringUpToDate === undefined ||
        (payload.kind === 'resume' && payload.followUpNumber !== undefined)) &&
      (payload.resumeReason !== 'bring_up_to_date' || payload.bringUpToDate === true),
    {
      path: ['bringUpToDate'],
      message:
        'A bring-up-to-date flag comes with a resume claim inside a Follow-up, and always with the resume reason bring_up_to_date.',
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
  )
  .refine((payload) => payload.diffState === undefined || payload.kind !== 'start', {
    path: ['diffState'],
    message: 'A start claim carries no diff state.',
  });
export type RunPayload = z.infer<typeof runPayloadSchema>;

/**
 * Problem `type`s (and 404) that mean the worker no longer holds the Run and must abandon it;
 * any other refusal, e.g. `illegal-run-transition`, is logged and the Run goes on. Pinned to the
 * API's list by a test.
 */
export const WORKER_PROBLEM_TYPES = {
  runNotHeld: 'urn:agentic-studio:problem:run-not-held',
  runNotFound: 'urn:agentic-studio:problem:run-not-found',
  stepLimitReached: 'urn:agentic-studio:problem:step-limit-reached',
  /** 409: the Clone no longer holds the commit the Run's agent was read at. */
  agentFolderUnavailable: 'urn:agentic-studio:problem:agent-folder-unavailable',
  /** 409: the agent's folder at that commit fails the shared validation. */
  agentFolderInvalid: 'urn:agentic-studio:problem:agent-folder-invalid',
  /** 409: the listing of the definitions Repository is cut, so the folder may be partial. */
  agentFolderCut: 'urn:agentic-studio:problem:agent-folder-cut',
  /** 409: the Clone no longer holds the commit or a skill the Run recorded. */
  skillsUnavailable: 'urn:agentic-studio:problem:skills-unavailable',
  /** 409: a skill of the Run at that commit fails the shared validation. */
  skillsInvalid: 'urn:agentic-studio:problem:skills-invalid',
} as const;

/** `POST /api/worker/runs/claim` body. */
export const claimRunRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type ClaimRunRequest = z.infer<typeof claimRunRequestSchema>;

/** `POST /api/worker/runs/:runId/heartbeat` body. */
export const heartbeatRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

/**
 * `POST /api/worker/runs/:runId/heartbeat` answer: whether the operator asked to cancel; the
 * worker then stops the Run step and reports `cancelled`.
 */
export const heartbeatResponseSchema = z.strictObject({ cancelRequested: z.boolean() });
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

/**
 * The states a worker reports; every other transition belongs to the API or the operator.
 * `cancelled` confirms an operator's cancel, `timed_out` a Run step stopped at its time limit.
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
 * Largest structured result, in bytes of UTF-8 JSON (96 KiB). The step report adds under 100
 * bytes around it, so every valid result fits Express's default 100 KiB body limit.
 */
export const RUN_STEP_RESULT_MAX_BYTES = 96 * 1024;

/** Size of a value as UTF-8 JSON, as it travels in a request body. */
export function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * The agent's question to the operator: its text, the options it offers and the one it
 * recommends. All of it is the agent's text, shown as plain text only.
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
 * The structured result a Run step ends with: `done`, or `needs_input` with the question (it
 * pauses the Run) and the session reference the answer resumes. The whole result stays within
 * {@link RUN_STEP_RESULT_MAX_BYTES}.
 */
export const runStepResultSchema = z
  .strictObject({
    outcome: z.enum(['done', 'needs_input']),
    summary: z.string().max(20_000),
    question: runQuestionSchema.optional(),
    /** The agent session the step ran in; required with `needs_input`. */
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

/** Longest commit subject in a Working copy report, in characters (the worker shortens it). */
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
 * What a Run's Working copy holds after a Run step: the Run branch, its commits since the start
 * commit (oldest first; when over {@link WORKING_COPY_COMMITS_MAX}, the newest), and whether
 * uncommitted changes remain.
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
 * A pull request's page on github.com, `https://github.com/<owner>/<repo>/pull/<n>`, without
 * credentials, port, query or fragment. Delivery targets GitHub only.
 */
const GITHUB_PULL_REQUEST_URL = /^https:\/\/github\.com\/[^/?#@:]+\/[^/?#@:]+\/pull\/[1-9]\d*$/;

/** The draft pull request a delivery opened or reused: its URL on github.com and number. */
export const pullRequestRefSchema = z.strictObject({
  url: z
    .url({ protocol: /^https$/, hostname: /^github\.com$/ })
    .max(PULL_REQUEST_URL_MAX_LENGTH)
    .regex(GITHUB_PULL_REQUEST_URL),
  number: z.number().int().positive(),
});
export type PullRequestRef = z.infer<typeof pullRequestRefSchema>;

/**
 * How a successful Run was delivered: `none` when the Run branch has no commits beyond the start
 * commit (nothing pushed), or `delivered` with the draft pull request. A failed delivery is the
 * failure `delivery_failed`.
 */
export const runDeliverySchema = z.discriminatedUnion('outcome', [
  z
    .strictObject({
      outcome: z.literal('none'),
      /**
       * Only with `cancelled`: the cancel arrived during the delivery; the Run branch was pushed
       * but no pull request was opened.
       */
      branchPushed: z.literal(true).optional(),
      /** With `branchPushed`: the commit the push left the remote Run branch at. */
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
     * The commit the push left the remote Run branch at; commits up to it are pushed, later ones
     * exist only in the Working copy.
     */
    pushedCommit: commitIdSchema.optional(),
  }),
]);
export type RunDelivery = z.infer<typeof runDeliverySchema>;

/**
 * Where a Run's pull request stands on the Git host: `draft` and `open` are open (a draft is
 * not ready for review); `merged` and `closed` are over; `missing` means the pull request, or
 * the Run branch it came from, no longer exists.
 */
export const PULL_REQUEST_STATES = ['draft', 'open', 'merged', 'closed', 'missing'] as const;
export const pullRequestStateSchema = z.enum(PULL_REQUEST_STATES);
export type PullRequestStateName = z.infer<typeof pullRequestStateSchema>;

/**
 * `POST /api/worker/runs/:runId/state` body: a failure exactly when the state is `failed`, a
 * delivery outcome exactly with `succeeded`. The Working copy's state may come with a stop or a
 * delivery (a delivery retry has no step report), so commits of a failed step are recorded.
 */
export const reportRunStateRequestSchema = z
  .strictObject({
    workerId: workerIdSchema,
    state: z.enum(WORKER_REPORTED_STATES),
    failure: runFailureSchema.optional(),
    delivery: runDeliverySchema.optional(),
    workingCopy: workingCopyReportSchema.optional(),
    /**
     * With `failed` / `usage_limit` only: the agent session, so the operator can resume the Run
     * once the limit resets.
     */
    sessionRef: sessionRefSchema.optional(),
    /**
     * With `failed` / `delivery_failed` only: the commit the Run branch was pushed to before the
     * delivery failed, so Studio still knows which commits are pushed.
     */
    pushedCommit: commitIdSchema.optional(),
    /**
     * With `failed` / `preparation_failed` only: the pull request state the worker read before it
     * refused to start a Follow-up (merged, closed or gone), shown without waiting for a lookup.
     */
    pullRequestState: pullRequestStateSchema.optional(),
    /**
     * With `running` of a bring-up-to-date claim only: the merge started. `baseCommit` is the Run
     * branch before it, `integrationCommit` the integration commit merged; Studio hands both back
     * with every later claim of the part.
     */
    bringUpToDateStarted: z
      .strictObject({ baseCommit: commitIdSchema, integrationCommit: commitIdSchema })
      .optional(),
    /**
     * With `succeeded` only: the bring-up-to-date request changed nothing (already up to date, or
     * the integration branch could not be fetched): no agent was started, nothing pushed, no
     * delivery. The Run goes back to the result it had before.
     */
    unchanged: z.literal(true).optional(),
    /** With `unchanged`: why nothing changed (default: already up to date). */
    unchangedDetail: z.string().min(1).max(FAILURE_DETAIL_MAX_LENGTH).optional(),
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
      report.unchanged === true
        ? report.state === 'succeeded' &&
          report.delivery === undefined &&
          report.workingCopy === undefined
        : report.state === 'succeeded'
          ? report.delivery !== undefined
          : report.delivery === undefined || report.state === 'cancelled',
    {
      path: ['delivery'],
      message:
        'A delivery outcome is reported with the state succeeded, or with cancelled when the ' +
        'cancel arrived during the delivery.',
    },
  )
  .refine((report) => report.sessionRef === undefined || report.failure?.code === 'usage_limit', {
    path: ['sessionRef'],
    message: 'A session reference comes only with the failure usage_limit.',
  })
  .refine(
    (report) =>
      report.pullRequestState === undefined || report.failure?.code === 'preparation_failed',
    {
      path: ['pullRequestState'],
      message: 'A pull request state on its own comes only with the failure preparation_failed.',
    },
  )
  .refine(
    (report) => report.pushedCommit === undefined || report.failure?.code === 'delivery_failed',
    {
      path: ['pushedCommit'],
      message: 'A pushed commit on its own comes only with the failure delivery_failed.',
    },
  )
  .refine((report) => report.bringUpToDateStarted === undefined || report.state === 'running', {
    path: ['bringUpToDateStarted'],
    message: 'The merge start comes only with the state running.',
  })
  .refine((report) => report.unchangedDetail === undefined || report.unchanged === true, {
    path: ['unchangedDetail'],
    message: 'A reason for no change comes only with unchanged.',
  })
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
   * The Run step's number, 1, 2, …: a retried report of a step Studio already stored is
   * recognised by it and changes nothing.
   */
  index: z.int().min(1).max(2_147_483_647),
  kind: z.enum(RUN_STEP_KINDS),
  result: runStepResultSchema,
  workingCopy: workingCopyReportSchema,
});
export type ReportRunStepRequest = z.infer<typeof reportRunStepRequestSchema>;

/**
 * A Run's diffs: after every Run step with a result, the worker compares the Working copy
 * (uncommitted and untracked changes included, Studio-placed files never) with the start commit
 * (`run`) and the previous result (`last`; `run` for the first). Studio redacts every patch.
 */
export const RUN_DIFF_SCOPES = ['run', 'last'] as const;
export type RunDiffScope = (typeof RUN_DIFF_SCOPES)[number];

/** How a file changed. A copy or a type change is reported as `modified`. */
export const RUN_DIFF_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type RunDiffFileStatus = (typeof RUN_DIFF_FILE_STATUSES)[number];

/** Most files one diff lists; the rest are left out and the diff is `truncated`. */
export const RUN_DIFF_FILES_MAX = 1000;

/** Longest file path in a diff, in characters. */
export const RUN_DIFF_PATH_MAX_LENGTH = 4096;

/**
 * Largest patch of one file and of all files of one diff, in bytes of its UTF-8 JSON (so the
 * request size stays bounded however the text escapes). The agent worker's own limits (its
 * configuration, defaults 256 KiB and 2 MiB) may not exceed these.
 */
export const RUN_DIFF_FILE_PATCH_MAX_BYTES = 512 * 1024;
export const RUN_DIFF_PATCH_MAX_BYTES = 4 * 1024 * 1024;

/** Largest diff (one scope), in bytes of its UTF-8 JSON: the patches plus the file list. */
export const RUN_DIFF_MAX_BYTES = 5 * 1024 * 1024;

/** Largest body of `POST /api/worker/runs/:runId/diff`: two diffs and the envelope. */
export const RUN_DIFF_REQUEST_MAX_BYTES = 2 * RUN_DIFF_MAX_BYTES + 64 * 1024;

/** Longest reason a diff could not be computed, in characters. */
export const RUN_DIFF_UNAVAILABLE_MAX_LENGTH = 500;

const diffPathSchema = z.string().min(1).max(RUN_DIFF_PATH_MAX_LENGTH);

/**
 * One changed file: path (and previous path of a rename), status, line counts and `patch`, Git's
 * unified diff with headers. A binary or `tooLarge` file has no patch, nor has a file listed after
 * the diff reached its total limit (the diff is then `truncated`).
 */
export const runDiffFileSchema = z
  .strictObject({
    path: diffPathSchema,
    previousPath: diffPathSchema.optional(),
    status: z.enum(RUN_DIFF_FILE_STATUSES),
    additions: z.int().min(0),
    deletions: z.int().min(0),
    binary: z.literal(true).optional(),
    tooLarge: z.literal(true).optional(),
    patch: z
      .string()
      .min(1)
      .refine((patch) => jsonByteLength(patch) <= RUN_DIFF_FILE_PATCH_MAX_BYTES, {
        message: `A patch is larger than ${RUN_DIFF_FILE_PATCH_MAX_BYTES} bytes as JSON.`,
      })
      .optional(),
  })
  .refine((file) => (file.status === 'renamed') === (file.previousPath !== undefined), {
    path: ['previousPath'],
    message: 'A renamed file, and only a renamed one, names its previous path.',
  })
  .refine((file) => file.patch === undefined || (!file.binary && !file.tooLarge), {
    path: ['patch'],
    message: 'A binary or too large file carries no patch.',
  });
export type RunDiffFile = z.infer<typeof runDiffFileSchema>;

/**
 * One diff: the commit it starts from (the start commit for `run`; for `last`, the commit the
 * previous result was at), whether it includes changes that are not pushed, whether a limit
 * left content or files out, and the files.
 */
export const runDiffSchema = z
  .strictObject({
    baseCommit: objectIdSchema,
    includesUnpushed: z.boolean(),
    truncated: z.boolean(),
    files: z.array(runDiffFileSchema).max(RUN_DIFF_FILES_MAX),
  })
  .refine((diff) => new Set(diff.files.map((file) => file.path)).size === diff.files.length, {
    path: ['files'],
    message: 'Each path is listed once.',
  })
  .refine(
    (diff) =>
      diff.files.reduce(
        (total, file) => total + (file.patch ? jsonByteLength(file.patch) : 0),
        0,
      ) <= RUN_DIFF_PATCH_MAX_BYTES,
    { path: ['files'], message: `The patches are larger than ${RUN_DIFF_PATCH_MAX_BYTES} bytes.` },
  )
  .refine((diff) => jsonByteLength(diff) <= RUN_DIFF_MAX_BYTES, {
    message: `The diff is larger than ${RUN_DIFF_MAX_BYTES} bytes as JSON.`,
  });
export type RunDiff = z.infer<typeof runDiffSchema>;

/**
 * `POST /api/worker/runs/:runId/diff` body: both diffs with their `state`, or the reason they
 * could not be computed (operator text, never a path or Git's output). Studio replaces the stored
 * diffs, but an unavailable report leaves the stored state as it was.
 */
export const reportRunDiffRequestSchema = z
  .strictObject({
    workerId: workerIdSchema,
    run: runDiffSchema.optional(),
    last: runDiffSchema.optional(),
    state: runDiffStateSchema.optional(),
    unavailable: z.string().min(1).max(RUN_DIFF_UNAVAILABLE_MAX_LENGTH).optional(),
  })
  .refine(
    (report) =>
      report.unavailable === undefined
        ? report.run !== undefined && report.last !== undefined && report.state !== undefined
        : report.run === undefined && report.last === undefined && report.state === undefined,
    {
      message:
        'A diff report carries both diffs and their state, or only the reason they are unavailable.',
    },
  );
export type ReportRunDiffRequest = z.infer<typeof reportRunDiffRequestSchema>;

/**
 * One event a runner streams while a Run step executes: an agent message, a tool call with its
 * command, a tool result, or a `notice` about the step itself (a denied tool call, a skipped
 * instruction import). The worker forwards each as a Run event.
 */
export const runnerEventSchema = z.strictObject({
  type: z.enum(['message', 'command', 'output', 'notice']),
  text: z.string().max(20_000),
});
export type RunnerEvent = z.infer<typeof runnerEventSchema>;

/** Most Run ids one states request asks about. */
export const RUN_STATES_REQUEST_MAX = 500;

/**
 * `POST /api/worker/runs/states` body: the Runs the worker has Working copies for, so it can
 * apply the retention rules.
 */
export const runStatesRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  runIds: z.array(z.uuid()).min(1).max(RUN_STATES_REQUEST_MAX),
  /**
   * Runs whose Working copies this worker's retention removed and has not reported yet; Studio
   * records the removal, so the Run page says a Follow-up is no longer possible.
   */
  removedRunIds: z.array(z.uuid()).max(RUN_STATES_REQUEST_MAX).optional(),
});
export type RunStatesRequest = z.infer<typeof runStatesRequestSchema>;

/**
 * The answer: one entry per asked Run that exists (an unknown id is left out), with its state
 * and, in a final state, when it finished.
 */
export const runStatesResponseSchema = z.array(
  z
    .strictObject({
      runId: z.uuid(),
      state: runStateSchema,
      finishedAt: z.iso.datetime().nullable(),
      /**
       * Studio decides how long a final Run's Working copy is kept: `keepUntil` at least until
       * then, `removable` remove it now. Neither (not final, or an older Studio): keep it.
       */
      keepUntil: z.iso.datetime().optional(),
      removable: z.literal(true).optional(),
      /**
       * With `removable` only: the Run's agent session, so the worker removes the session files
       * the provider's CLI keeps for it together with the Working copy. Never a credential.
       */
      session: z
        .strictObject({ provider: providerSchema, ref: z.string().min(1).max(256) })
        .optional(),
    })
    .refine((entry) => entry.keepUntil === undefined || entry.removable === undefined, {
      path: ['removable'],
      message: 'A Run is either kept until a time or removable, not both.',
    })
    .refine((entry) => entry.session === undefined || entry.removable === true, {
      path: ['session'],
      message: 'The agent session comes only with a removable Run.',
    }),
);
export type RunStatesResponse = z.infer<typeof runStatesResponseSchema>;
/**
 * The kinds of Run event: the runner's three, the worker's step markers, and `notice` for what
 * Studio or the worker says about the log itself (e.g. "log truncated").
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
 * `POST /api/worker/runs/:runId/events` body: a batch in strictly increasing `seq` order. Studio
 * ignores events it already stored (an idempotent re-send) and accepts a gap.
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
 * How the agent worker carries out Runs: `cli` starts the provider's official CLI (production);
 * `fake` is the scripted fake runner, allowed only in development and test configurations.
 */
export const WORKER_RUNNER_MODES = ['fake', 'cli'] as const;
export type WorkerRunnerMode = (typeof WORKER_RUNNER_MODES)[number];

/** Longest reason a worker gives for an unavailable provider. */
export const PROVIDER_REASON_MAX_LENGTH = 500;

const providerReasonSchema = z.string().min(1).max(PROVIDER_REASON_MAX_LENGTH);

/**
 * The disk the worker keeps Working copies and caches on, measured at most every ten minutes.
 * Sizes are bytes of data (a file linked twice counts once); `keptRuns` counts held Run dirs;
 * `minFreeBytes` (`STUDIO_WORKER_MIN_FREE_GB`) is the free space below which no Run is prepared.
 */
const DISK_BYTES_MAX = Number.MAX_SAFE_INTEGER;
export const workerDiskSchema = z.strictObject({
  workingCopiesBytes: z.int().min(0).max(DISK_BYTES_MAX),
  cachesBytes: z.int().min(0).max(DISK_BYTES_MAX),
  keptRuns: z.int().min(0).max(PG_INT_MAX),
  freeBytes: z.int().min(0).max(DISK_BYTES_MAX),
  totalBytes: z.int().min(0).max(DISK_BYTES_MAX),
  minFreeBytes: z.int().min(0).max(DISK_BYTES_MAX),
  /** Some files could not be read while measuring: the byte figures are lower bounds. */
  partial: z.literal(true).optional(),
});
export type WorkerDisk = z.infer<typeof workerDiskSchema>;

/**
 * `POST /api/worker/status` body: the worker's runner mode and the providers its own
 * configuration enables, sent at start and with every poll. A report for display and for refusing
 * hopeless starts; the worker's own check stays authoritative.
 */
export const workerStatusRequestSchema = z.strictObject({
  workerId: workerIdSchema,
  runner: z.enum(WORKER_RUNNER_MODES),
  providers: providerSwitchesSchema,
  /**
   * Why a provider whose switch is on cannot run here (e.g. its CLI is missing or unsupported).
   * A reason makes the provider unavailable on top of the switches. Operator text, never a path
   * or a credential.
   */
  providerReasons: z
    .strictObject({
      claude_code: providerReasonSchema.optional(),
      codex: providerReasonSchema.optional(),
    } satisfies Record<Provider, z.ZodOptional<z.ZodString>>)
    .optional(),
  /** Left out until the worker has measured its disk. */
  disk: workerDiskSchema.optional(),
});
export type WorkerStatusRequest = z.infer<typeof workerStatusRequestSchema>;

/** What a worker reports about itself: the status request without the worker id. */
export type WorkerStatusReport = Omit<WorkerStatusRequest, 'workerId'>;

/**
 * Lookups: Studio's questions for the Git host that only the agent worker can answer, through
 * the Agent account; any connected worker claims one (no Working copy needed) and reports the
 * result. Reads only: a lookup never changes the Git host or starts an agent CLI.
 */
export const LOOKUP_KINDS = [
  'pull_request_state',
  'failing_check_logs',
  'review_comments',
] as const;
export const lookupKindSchema = z.enum(LOOKUP_KINDS);
export type LookupKind = z.infer<typeof lookupKindSchema>;

/** Most lookups one claim hands out. */
export const LOOKUP_CLAIM_MAX = 5;

/**
 * How a Pull request check stands: `queued` and `running` have not finished, the rest have. The
 * API's list is pinned to this one by a test.
 */
export const PULL_REQUEST_CHECK_STATES = [
  'queued',
  'running',
  'passed',
  'failed',
  'skipped',
  'cancelled',
] as const;
export const pullRequestCheckStateSchema = z.enum(PULL_REQUEST_CHECK_STATES);
export type PullRequestCheckState = z.infer<typeof pullRequestCheckStateSchema>;

/** Most Pull request checks a result carries; GitHub's rest are left out. */
export const PULL_REQUEST_CHECKS_MAX = 100;

/** Longest name of a Pull request check, in characters. */
export const PULL_REQUEST_CHECK_NAME_MAX_LENGTH = 200;

/** A web link (http or https) as a check or the Git host gives it. */
const webUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(REMOTE_URL_MAX_LENGTH)
  // A link with credentials in it is never stored or shown.
  .refine((link) => {
    try {
      const { username, password } = new URL(link);
      return username === '' && password === '';
    } catch {
      return false;
    }
  });

/** Size of a text in UTF-8 bytes. */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A Pull request check as the Git host reports it: name, state, duration, link. */
export const pullRequestCheckSchema = z.strictObject({
  name: z.string().min(1).max(PULL_REQUEST_CHECK_NAME_MAX_LENGTH),
  state: pullRequestCheckStateSchema,
  durationSeconds: z.int().min(0).max(PG_INT_MAX).optional(),
  url: webUrlSchema,
});
export type PullRequestCheck = z.infer<typeof pullRequestCheckSchema>;

/**
 * The result of a `pull_request_state` lookup: the state, how far the Run branch is behind and
 * ahead of the integration branch, and whether it merges cleanly (`mergeable`; left out until the
 * host knows). Draft or open: `checks` of the latest commit, or `checksUnavailable` if refused.
 */
export const pullRequestStateResultSchema = z
  .strictObject({
    state: pullRequestStateSchema,
    behindBy: z.int().min(0).max(PG_INT_MAX).optional(),
    aheadBy: z.int().min(0).max(PG_INT_MAX).optional(),
    mergeable: z.boolean().optional(),
    checksCommit: commitIdSchema.optional(),
    /** Empty means none are configured or reported. */
    checks: z.array(pullRequestCheckSchema).max(PULL_REQUEST_CHECKS_MAX).optional(),
    /** The Git host refused to report checks (the Agent account lacks the permission). */
    checksUnavailable: z.literal(true).optional(),
  })
  .refine(
    (result) =>
      (result.state !== 'merged' && result.state !== 'missing') ||
      (result.behindBy === undefined &&
        result.aheadBy === undefined &&
        result.mergeable === undefined),
    {
      path: ['state'],
      message: 'A merged or missing pull request has no branch position and no merge verdict.',
    },
  )
  .refine((result) => result.state !== 'closed' || result.mergeable === undefined, {
    path: ['mergeable'],
    message: 'A closed pull request has no merge verdict.',
  })
  .refine(
    (result) =>
      (result.state === 'draft' || result.state === 'open'
        ? true
        : result.checks === undefined &&
          result.checksCommit === undefined &&
          result.checksUnavailable === undefined) &&
      (result.checks === undefined) === (result.checksCommit === undefined) &&
      !(result.checks !== undefined && result.checksUnavailable !== undefined),
    {
      path: ['checks'],
      message:
        'Pull request checks come with their commit, for a draft or open pull request only, and not together with checksUnavailable.',
    },
  );
export type PullRequestStateResult = z.infer<typeof pullRequestStateResultSchema>;

/**
 * What a `review_comments` lookup loads: the comments created since the Run's latest result, or
 * all that are unresolved.
 */
export const REVIEW_COMMENT_SCOPES = ['since_last_result', 'unresolved'] as const;
export const reviewCommentScopeSchema = z.enum(REVIEW_COMMENT_SCOPES);
export type ReviewCommentScope = z.infer<typeof reviewCommentScopeSchema>;

/** The kinds of Review comment: a review's summary, an inline diff comment, a conversation one. */
export const REVIEW_COMMENT_KINDS = ['review', 'inline', 'conversation'] as const;
export const reviewCommentKindSchema = z.enum(REVIEW_COMMENT_KINDS);
export type ReviewCommentKind = z.infer<typeof reviewCommentKindSchema>;

/** A review summary's verdict. */
export const REVIEW_VERDICTS = ['commented', 'changes_requested', 'approved'] as const;
export const reviewVerdictSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/** Most Review comments one load keeps; the rest are left out and `truncated` says so. */
export const REVIEW_COMMENTS_MAX = 100;

/** Longest text of one Review comment, in UTF-8 bytes (8 KiB); a longer one is cut. */
export const REVIEW_COMMENT_TEXT_MAX_BYTES = 8 * 1024;

/** Most lines of the diff shown around an inline comment. */
export const REVIEW_COMMENT_DIFF_CONTEXT_MAX_LINES = 6;

/** Longest diff context of one inline comment, in UTF-8 bytes. */
export const REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES = 2 * 1024;

/** Longest author login (GitHub's own limit is 39; bots add a suffix). */
export const REVIEW_COMMENT_AUTHOR_MAX_LENGTH = 100;

/** Longest file path of an inline comment, in characters. */
export const REVIEW_COMMENT_PATH_MAX_LENGTH = 500;

/**
 * One Review comment as the worker read it; `id` is unique across the three kinds (`review-<n>`,
 * `inline-<n>`, `conversation-<n>`). The text is untrusted, anyone can comment on a public pull
 * request: Studio redacts it, shows plain text and sends only what the operator selects.
 */
export const reviewCommentSchema = z.strictObject({
  id: z.string().regex(/^(?:review|inline|conversation)-[0-9]{1,20}$/),
  author: z.string().min(1).max(REVIEW_COMMENT_AUTHOR_MAX_LENGTH),
  kind: reviewCommentKindSchema,
  path: z.string().min(1).max(REVIEW_COMMENT_PATH_MAX_LENGTH).optional(),
  line: z.int().positive().max(PG_INT_MAX).optional(),
  diffContext: z
    .string()
    .refine((text) => utf8Length(text) <= REVIEW_COMMENT_DIFF_CONTEXT_MAX_BYTES, {
      message: 'A diff context is at most 2 KiB.',
    })
    .optional(),
  verdict: reviewVerdictSchema.optional(),
  text: z.string().refine((text) => utf8Length(text) <= REVIEW_COMMENT_TEXT_MAX_BYTES, {
    message: 'A comment text is at most 8 KiB.',
  }),
  textCut: z.literal(true).optional(),
  createdAt: z.iso.datetime(),
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

/**
 * The unresolved comments of the pull request in the order written, without the Agent account's
 * own and those of resolved threads; `truncated` when more than {@link REVIEW_COMMENTS_MAX}
 * existed or a text was cut.
 */
export const reviewCommentsResultSchema = z
  .strictObject({
    comments: z.array(reviewCommentSchema).max(REVIEW_COMMENTS_MAX),
    truncated: z.boolean(),
  })
  .refine(
    (result) =>
      new Set(result.comments.map((comment) => comment.id)).size === result.comments.length &&
      result.comments.every(
        (comment) =>
          (comment.kind === 'inline') === (comment.path !== undefined) &&
          (comment.kind === 'inline' ||
            (comment.line === undefined && comment.diffContext === undefined)) &&
          (comment.kind === 'review') === (comment.verdict !== undefined) &&
          (comment.textCut === undefined || result.truncated),
      ),
    {
      path: ['comments'],
      message:
        'Comment ids are unique; only an inline comment has a file, line and diff context, only a review a verdict; a cut text sets truncated.',
    },
  );
export type ReviewCommentsResult = z.infer<typeof reviewCommentsResultSchema>;

/**
 * One claimed lookup (`POST /api/worker/lookups/claim` answers an array, empty when none waits):
 * what the worker needs, nothing else. The repository is the remote as connected, never a
 * credential; the worker checks it names a GitHub repository and the pull request is the Run's.
 */
export const lookupPayloadSchema = z
  .strictObject({
    id: z.uuid(),
    kind: lookupKindSchema,
    runId: z.uuid(),
    repository: z.strictObject({ remoteUrl: z.string().min(1).max(REMOTE_URL_MAX_LENGTH) }),
    pullRequestNumber: z.int().positive().max(PG_INT_MAX),
    /** The Run branch the pull request must come from. */
    runBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH),
    /** The integration branch the Run branch is compared with. */
    integrationBranch: z.string().min(1).max(BRANCH_NAME_MAX_LENGTH),
    /** What a `review_comments` lookup loads; present for that kind only. */
    reviewComments: z
      .strictObject({
        scope: reviewCommentScopeSchema,
        /** For `since_last_result`: only comments created after this time; none: all unresolved. */
        since: z.iso.datetime().optional(),
      })
      .optional(),
  })
  .refine(
    (lookup) => (lookup.kind === 'review_comments') === (lookup.reviewComments !== undefined),
    {
      path: ['reviewComments'],
      message: 'A review_comments lookup says what to load, and no other lookup does.',
    },
  );
export type LookupPayload = z.infer<typeof lookupPayloadSchema>;

/** `POST /api/worker/lookups/claim` body. */
export const claimLookupsRequestSchema = z.strictObject({ workerId: workerIdSchema });
export type ClaimLookupsRequest = z.infer<typeof claimLookupsRequestSchema>;

export const claimLookupsResponseSchema = z.array(lookupPayloadSchema).max(LOOKUP_CLAIM_MAX);
export type ClaimLookupsResponse = z.infer<typeof claimLookupsResponseSchema>;

/** Longest error text a worker gives for a failed lookup, in characters. */
export const LOOKUP_ERROR_MAX_LENGTH = 500;

/** Longest wait a worker may ask for before a rate-limited lookup is tried again, in seconds. */
export const LOOKUP_RETRY_AFTER_MAX_SECONDS = 24 * 60 * 60;

/**
 * Why a lookup failed: `scope_mismatch` (refused by the worker: not a GitHub repository or not the
 * Run's own pull request; never retried), `rate_limited` (retried after `retryAfterSeconds`) or
 * `failed` (anything else; not retried by itself).
 */
export const LOOKUP_ERROR_CODES = ['scope_mismatch', 'rate_limited', 'failed'] as const;
export const lookupErrorCodeSchema = z.enum(LOOKUP_ERROR_CODES);
export type LookupErrorCode = z.infer<typeof lookupErrorCodeSchema>;

/** Longest log excerpt of one failed check, in UTF-8 bytes (16 KiB). */
export const FAILING_CHECK_EXCERPT_MAX_LENGTH = 16 * 1024;

/** Longest total of the log excerpts of one `failing_check_logs` result, in UTF-8 bytes (64 KiB). */
export const FAILING_CHECK_EXCERPTS_TOTAL_MAX_LENGTH = 64 * 1024;

/**
 * The result of a `failing_check_logs` lookup: each failed check of the latest commit with name
 * and link and, when readable, the last lines of its log (`excerpt`). The text is untrusted, it
 * comes from a CI job: Studio redacts and fits it before showing it to the operator.
 */
export const failingCheckLogsResultSchema = z
  .strictObject({
    commit: commitIdSchema,
    checks: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(PULL_REQUEST_CHECK_NAME_MAX_LENGTH),
          url: webUrlSchema,
          logAvailable: z.boolean(),
          excerpt: z
            .string()
            .refine((text) => utf8Length(text) <= FAILING_CHECK_EXCERPT_MAX_LENGTH, {
              message: 'An excerpt is at most 16 KiB.',
            })
            .optional(),
          /** Why there is no log (no permission, expired, too large), when there is none. */
          note: z.string().max(LOOKUP_ERROR_MAX_LENGTH).optional(),
        }),
      )
      .max(PULL_REQUEST_CHECKS_MAX),
  })
  .refine(
    (result) =>
      result.checks.every((check) => check.logAvailable === (check.excerpt !== undefined)) &&
      result.checks.reduce((sum, check) => sum + utf8Length(check.excerpt ?? ''), 0) <=
        FAILING_CHECK_EXCERPTS_TOTAL_MAX_LENGTH,
    {
      path: ['checks'],
      message:
        'An excerpt comes with an available log only, and all excerpts total at most 64 KiB.',
    },
  );
export type FailingCheckLogsResult = z.infer<typeof failingCheckLogsResultSchema>;

/**
 * `POST /api/worker/lookups/:id/result` body: the result of the lookup's kind, or why it
 * failed (text for the operator, never a token or a path). Closed; Studio checks the kind is
 * the claimed lookup's.
 */
export const lookupResultRequestSchema = z.union([
  z.strictObject({
    workerId: workerIdSchema,
    ok: z.literal(true),
    kind: z.literal('pull_request_state'),
    result: pullRequestStateResultSchema,
  }),
  z.strictObject({
    workerId: workerIdSchema,
    ok: z.literal(true),
    kind: z.literal('failing_check_logs'),
    result: failingCheckLogsResultSchema,
  }),
  z.strictObject({
    workerId: workerIdSchema,
    ok: z.literal(true),
    kind: z.literal('review_comments'),
    result: reviewCommentsResultSchema,
  }),
  z.strictObject({
    workerId: workerIdSchema,
    ok: z.literal(false),
    code: lookupErrorCodeSchema,
    error: z.string().min(1).max(LOOKUP_ERROR_MAX_LENGTH),
    retryAfterSeconds: z.int().min(1).max(LOOKUP_RETRY_AFTER_MAX_SECONDS).optional(),
  }),
]);
export type LookupResultRequest = z.infer<typeof lookupResultRequestSchema>;

/** Most files in an agent folder hand-over; the validation's own limit is the stricter one. */
export const AGENT_FOLDER_FILES_MAX = 100;

/** `GET /api/worker/runs/:runId/agent-folder` query: the worker names neither agent nor commit. */
export const agentFolderQuerySchema = z.strictObject({ workerId: workerIdSchema });
export type AgentFolderQuery = z.infer<typeof agentFolderQuerySchema>;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The files of the Run's agent folder at its recorded commit, without `AGENT.md` (the
 * instructions travel in the claim). A built-in agent has no commit and no files. The worker
 * validates paths and sizes again before it writes anything.
 */
export const agentFolderResponseSchema = z
  .strictObject({
    commit: commitIdSchema.nullable(),
    files: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(1024),
          /** Git mode `100755`; every other file is `0644`. */
          executable: z.boolean(),
          contentBase64: z
            .string()
            .max(2 * 1024 * 1024)
            .regex(BASE64),
        }),
      )
      .max(AGENT_FOLDER_FILES_MAX),
  })
  .refine((answer) => answer.commit !== null || answer.files.length === 0, {
    path: ['files'],
    message: 'A built-in agent has no files.',
  });
export type AgentFolderResponse = z.infer<typeof agentFolderResponseSchema>;

/** `GET /api/worker/runs/:runId/skills` query: the worker names neither a skill nor a commit. */
export const runSkillsQuerySchema = z.strictObject({ workerId: workerIdSchema });
export type RunSkillsQuery = z.infer<typeof runSkillsQuerySchema>;

/** Most files in one skill folder: the validation's limit, repeated here for the wire. */
export const RUN_SKILL_FILES_MAX = 100;

/**
 * The files of the Run's skills at the Run's recorded commit, `SKILL.md` included, in the order
 * the Run lists them. `omitted` names the skills left out because the files of the skills before
 * them already reached {@link RUN_SKILLS_MAX_BYTES}. The worker validates everything again.
 */
export const runSkillsResponseSchema = z
  .strictObject({
    commit: commitIdSchema.nullable(),
    skills: z
      .array(
        z.strictObject({
          name: skillNameSchema,
          files: z
            .array(
              z.strictObject({
                path: z.string().min(1).max(1024),
                /** Git mode `100755`; every other file is `0644`. */
                executable: z.boolean(),
                contentBase64: z
                  .string()
                  .max(2 * 1024 * 1024)
                  .regex(BASE64),
              }),
            )
            .max(RUN_SKILL_FILES_MAX),
        }),
      )
      .max(RUN_SKILLS_MAX),
    omitted: z.array(skillNameSchema).max(RUN_SKILLS_MAX),
  })
  .refine(
    (answer) => answer.commit !== null || answer.skills.length + answer.omitted.length === 0,
    {
      path: ['skills'],
      message: 'A Run without a commit has no skills.',
    },
  );
export type RunSkillsResponse = z.infer<typeof runSkillsResponseSchema>;
