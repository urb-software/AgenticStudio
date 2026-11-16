/**
 * The Run (Issue #96): one Task carried out by a Provider on one Project, from a recorded
 * commit of the integration branch. The worker protocol's enums (`@agentic-studio/contracts`)
 * and the HTTP contract's are pinned to the lists here by tests; the database CHECK
 * constraints are written from them.
 */

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
export type RunState = (typeof RUN_STATES)[number];

/** States that count against the concurrency limits: an agent worker or the operator holds the Run. */
export const ACTIVE_RUN_STATES = [
  'preparing',
  'running',
  'waiting_for_operator',
] as const satisfies readonly RunState[];

/**
 * States in which a Run is under way without the operator (Issue #115): queued ones count too,
 * they are on their way, only not started yet. The run indicator's "running".
 */
export const UNDER_WAY_RUN_STATES = [
  'queued',
  'preparing',
  'running',
] as const satisfies readonly RunState[];

/** States an agent worker holds the Run in (it sends heartbeats); the lost-worker sweep's scope. */
export const CLAIMED_RUN_STATES = ['preparing', 'running'] as const satisfies readonly RunState[];

/** Final states: terminal, the Run is over. */
export const FINAL_RUN_STATES = [
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const satisfies readonly RunState[];

/** At most this many active Runs across the server (ADR 0002). */
export const MAX_ACTIVE_RUNS = 2;

export const PROVIDERS = ['claude_code', 'codex'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Why a Run failed: the fixed codes of Issue #96. */
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
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export interface RunFailure {
  code: RunFailureCode;
  /** A short explanation; never a secret. */
  detail: string;
}

/** Longest Task, in characters. */
export const TASK_MAX_LENGTH = 20_000;

/**
 * Where a Run's pull request stands on the Git host (Issue #142): `draft` and `open` are open;
 * `merged` and `closed` are over; `missing` means the pull request, or the Run branch it came
 * from, no longer exists. The worker protocol's list is pinned to this one by a test.
 */
export const PULL_REQUEST_STATES = ['draft', 'open', 'merged', 'closed', 'missing'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

/** The Follow-up refusal for each state in which no pull request is left to update. */
export const PULL_REQUEST_ENDED_REFUSALS = {
  merged: 'pull_request_merged',
  closed: 'pull_request_closed',
  missing: 'pull_request_missing',
} as const satisfies Partial<Record<PullRequestState, FollowUpRefusal>>;

/**
 * What Studio knows about the Run's pull request (Issue #142), from the lookups the agent worker
 * answered through the Agent account; Studio itself never reads the Git host. `state` is `null`
 * until the first lookup succeeded, and is kept when a later one fails (`refreshError` then says
 * why). Every field is `null` for a Run without a pull request.
 */
export interface RunPullRequestStatus {
  state: PullRequestState | null;
  /** Commits the Run branch is behind / ahead of the integration branch at that lookup. */
  behindBy: number | null;
  aheadBy: number | null;
  /** Whether the Git host said it can be merged without conflicts; `null` when it did not say. */
  mergeable: boolean | null;
  /** When the state was read. */
  refreshedAt: Date | null;
  /** Why the latest lookup failed; cleared by a success. */
  refreshError: string | null;
  /** A rate-limited lookup is tried again at this time. */
  retryAt: Date | null;
  /** Set while a lookup waits for an agent worker or is being answered. */
  refreshRequestedAt: Date | null;
  /** When a lookup was last requested, whether or not it succeeded (review S1 of #152). */
  lastAttemptAt: Date | null;
  /**
   * Issue #143: when a lookup first read the pull request as merged, closed or missing; `null`
   * while it is not over (a reopened one is cleared). Working copy retention counts from it.
   */
  endedAt: Date | null;
}

/** No lookup yet: what a Run starts with. */
export const NO_PULL_REQUEST_STATUS: RunPullRequestStatus = {
  state: null,
  behindBy: null,
  aheadBy: null,
  mergeable: null,
  refreshedAt: null,
  refreshError: null,
  retryAt: null,
  refreshRequestedAt: null,
  lastAttemptAt: null,
  endedAt: null,
};

/** One commit on a Run branch: its id and subject line. */
export interface RunCommit {
  id: string;
  subject: string;
}

/**
 * The Working copy's state as the agent worker last reported it after a Run step (Issue #98):
 * the Run branch, its commits since the start commit (oldest first, capped by the worker
 * protocol) and whether uncommitted changes remain.
 */
export interface RunWorkingCopy {
  runBranch: string;
  commits: RunCommit[];
  hasUncommittedChanges: boolean;
}

/**
 * The limits of a Run (Issue #100), from the API's configuration, copied onto the Run when it
 * is started: the longest a Run step may work, the most Run steps the Run may take, and the
 * longest it may wait for the operator before it is cancelled.
 */
export interface RunLimits {
  stepMinutes: number;
  /** The most Run steps the first part of the Run, and each Follow-up, may take (Issue #141). */
  maxSteps: number;
  waitingDays: number;
  /** The most Run steps the Run may take in total before it accepts no Follow-up (Issue #141). */
  maxTotalSteps: number;
}

/** Who cancelled a Run (Issue #100): the operator, or Studio itself (a Run waiting too long). */
export const RUN_CANCELLED_BY = ['operator', 'system'] as const;
export type RunCancelledBy = (typeof RUN_CANCELLED_BY)[number];

/** Why a Run was cancelled; set exactly when `cancelled`. */
export interface RunCancellation {
  by: RunCancelledBy;
  /** A short explanation, shown to the operator. */
  reason: string;
}

/**
 * How a Run was delivered (Issue #102): `none` (succeeded, the Run branch had no new commits:
 * "No changes"), `delivered` (succeeded, with its draft pull request) or `failed` (the Run failed
 * with `delivery_failed`). `null` until then.
 */
export const RUN_DELIVERIES = ['none', 'delivered', 'failed'] as const;
export type RunDeliveryState = (typeof RUN_DELIVERIES)[number];

/** The draft pull request a delivery opened or reused. */
export interface RunPullRequest {
  url: string;
  number: number;
}

/**
 * What an agent worker reports about a successful delivery; `pushedCommit` (Issue #141) is the
 * commit the push left the remote Run branch at.
 */
export type RunDeliveryOutcome =
  /** `branchPushed`: only for a Run cancelled after its push, before a pull request (#124 review). */
  | { outcome: 'none'; branchPushed?: true; pushedCommit?: string }
  | { outcome: 'delivered'; pullRequest: RunPullRequest; pushedCommit?: string };

/** Longest operator answer to an agent's question, in characters (Issue #103). */
export const ANSWER_MAX_LENGTH = 10_000;

/** Longest Follow-up, in characters (Issue #141). */
export const FOLLOW_UP_MAX_LENGTH = 10_000;

/**
 * The agent's question to the operator (Issue #103), from a `needs_input` step result: its
 * text, the options it offers and the one it recommends. The agent's text: never markup.
 */
export interface RunQuestion {
  text: string;
  options?: string[];
  recommendation?: string;
}

/**
 * One turn of the Run's conversation after its Task (Issue #103), in order: the agent's
 * question, the operator's answer to it, or the operator's Follow-up to the finished Run
 * (Issue #141).
 */
export type RunMessage =
  | { kind: 'question'; question: RunQuestion; at: Date }
  | { kind: 'answer'; text: string; at: Date }
  | { kind: 'follow_up'; text: string; at: Date }
  | ({ kind: 'part_end'; at: Date } & RunPartEnd);

/**
 * How a part of the Run (its first part, or a Follow-up) ended (review S1 of #150): recorded
 * when a Follow-up reopens the Run, before its result is cleared, so the earlier result stays
 * in the conversation. `detail` is the failure detail (redacted when it was reported) or the
 * cancellation reason; empty otherwise.
 */
export interface RunPartEnd {
  state: Extract<RunState, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;
  failureCode: RunFailureCode | null;
  delivery: RunDeliveryState | null;
  detail: string;
}

/** The end of the Run's current part, as {@link RunPartEnd}; `null` while it is not final. */
export function partEndOf(
  run: Pick<Run, 'state' | 'failure' | 'cancellation' | 'delivery'>,
): RunPartEnd | null {
  if (!isFinal(run.state)) return null;
  return {
    state: run.state as RunPartEnd['state'],
    failureCode: run.failure?.code ?? null,
    delivery: run.delivery,
    detail: run.failure?.detail ?? run.cancellation?.reason ?? '',
  };
}

export interface Run {
  id: string;
  projectId: string;
  provider: Provider;
  task: string;
  state: RunState;
  /** The integration branch's commit when the Run was started. */
  startCommit: string;
  /** The Repository's remote URL when the Run was started (Issue #98); never a credential. */
  remoteUrl: string;
  /** The latest reported Working copy state; `null` until the first Run step is reported. */
  workingCopy: RunWorkingCopy | null;
  /** The Repository's integration branch when the Run was started: its pull request's base. */
  integrationBranch: string;
  /** How the Run was delivered (Issue #102); `null` until it is. */
  delivery: RunDeliveryState | null;
  /** Set exactly when `delivery` is `delivered`. */
  pullRequest: RunPullRequest | null;
  /**
   * The operator asked to retry the failed delivery; it stays set while an agent worker holds
   * the Run for the retry (`claimedBy`), until the worker reports the outcome.
   */
  deliveryRequested: boolean;
  /** Names of the checks the agent reported failed in the latest Run step. */
  failingChecks: string[];
  createdAt: Date;
  /** When an agent worker claimed it. */
  startedAt: Date | null;
  /** When it reached a final state. */
  finishedAt: Date | null;
  /** Set exactly when `failed`. */
  failure: RunFailure | null;
  /**
   * The agent worker holding it: set exactly when `preparing` or `running`, or while it retries
   * the delivery of a `failed` Run (Issue #102).
   */
  claimedBy: string | null;
  /**
   * Whether the Run was given its Project's Environment file when it was claimed (Issue #104):
   * a snapshot taken then; later changes to the file affect only later Runs. Never the content.
   */
  environmentFileSupplied: boolean;
  /**
   * That file's path in the Working copy, set exactly when supplied: never committed or pushed
   * by a delivery, a retry too (Issue #102's `studioPaths`). Not secret, not in the operator API.
   */
  environmentFilePath: string | null;
  /** The limits in force for this Run (Issue #100). */
  limits: RunLimits;
  /**
   * When the operator asked to cancel a `preparing` or `running` Run (Issue #100); the Run
   * stays in its state until the agent worker confirms the stop.
   */
  cancelRequestedAt: Date | null;
  /** Set exactly when `cancelled`. */
  cancellation: RunCancellation | null;
  /** When it began waiting for the operator; set exactly when `waiting_for_operator`. */
  waitingSince: Date | null;
  /**
   * When the current Run step started: set whenever the Run goes to `running`, cleared when the
   * step's result is reported (Studio's time-limit backstop then stops: review of #121).
   */
  stepStartedAt: Date | null;
  /**
   * The agent worker that released the Run (to `waiting_for_operator` or a final state), so a
   * retried report of that same change is recognised (review of #121).
   */
  releasedBy: string | null;
  /**
   * The agent session the last Run step reported (Issue #103): an answer resumes it. Internal:
   * it goes to the agent worker that holds the Working copy, never to the operator API.
   */
  sessionRef: string | null;
  /** The agent's questions, the operator's answers and Follow-ups, in order (Issue #103). */
  messages: RunMessage[];
  /**
   * The agent worker that last claimed the Run to start or resume it (Issue #102): only it holds
   * the Working copy and the agent's session. Internal, never in the operator API.
   */
  lastClaimedBy: string | null;
  /** How many Run steps the Run has taken (stored step results; Issue #141). */
  stepCount: number;
  /** How many Follow-ups the operator sent (Issue #141). */
  followUpCount: number;
  /** Queued for a Follow-up its agent worker has not claimed yet (Issue #141). */
  followUpQueued: boolean;
  /** How many Run steps the Run had taken when its current part began (Issue #141). */
  stepsBeforePart: number;
  /** The commit the latest push left the remote Run branch at (Issue #141); `null` if none. */
  pushedCommit: string | null;
  /** When the agent worker reported its retention removed the Working copy (Issue #141). */
  workingCopyRemovedAt: Date | null;
  /** Where the Run's pull request stands on the Git host, as last read (Issue #142). */
  pullRequestStatus: RunPullRequestStatus;
  /**
   * The latest Run step, Answer or Follow-up, or the Run's creation (Issue #143): Working copy
   * retention counts a Run with a pull request idle from here.
   */
  lastActivityAt: Date;
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'cancelled', 'timed_out'],
  preparing: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['waiting_for_operator', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  // Issue #103: the operator's answer queues the Run again; a worker claims it to resume.
  waiting_for_operator: ['queued', 'cancelled', 'timed_out'],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

/**
 * Whether the operator may retry the Run's delivery (Issue #102): only a `failed` Run whose
 * failure is `delivery_failed`. Its outcome is the one exception to the final states: on
 * success the Run becomes `succeeded`, otherwise it stays `failed` with the new reason.
 */
export function canRetryDelivery(run: Pick<Run, 'state' | 'failure'>): boolean {
  return run.state === 'failed' && run.failure?.code === 'delivery_failed';
}

/** Retrying the delivery of a Run that is not `failed` with `delivery_failed`. */
export class DeliveryNotRetryableError extends Error {
  constructor() {
    super('Only a run whose delivery failed can retry its delivery.');
    this.name = 'DeliveryNotRetryableError';
  }
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(state: RunState): boolean {
  return (FINAL_RUN_STATES as readonly RunState[]).includes(state);
}

/** A transition the state machine does not allow. */
export class IllegalRunTransitionError extends Error {
  constructor(
    readonly from: RunState,
    readonly to: RunState,
  ) {
    super(`A Run cannot go from ${from} to ${to}.`);
    this.name = 'IllegalRunTransitionError';
  }
}

/** Throws {@link IllegalRunTransitionError} unless `from` → `to` is allowed. */
export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalRunTransitionError(from, to);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` can be a Run id (a UUID); anything else names no Run. */
export function isRunId(value: string): boolean {
  return UUID.test(value);
}

/** Cancelling a Run that has already reached a final state (Issue #100). */
export class RunAlreadyFinishedError extends Error {
  constructor(readonly state: RunState) {
    super('Run already finished');
    this.name = 'RunAlreadyFinishedError';
  }
}

/**
 * The cancellation recorded when the operator's cancel arrived during the delivery, after the
 * Run branch was pushed but before a pull request was opened (review of #124).
 */
export const OPERATOR_CANCELLATION_BRANCH_PUSHED: RunCancellation = {
  by: 'operator',
  reason:
    'Cancelled by the operator during its delivery: the Run branch was pushed, no pull request was opened.',
};

/** The cancellation recorded when the operator cancels a Run (Issue #100). */
export const OPERATOR_CANCELLATION: RunCancellation = {
  by: 'operator',
  reason: 'Cancelled by the operator.',
};

/**
 * The long-wait rule (Issue #100): a Run waiting for the operator longer than its
 * `waitingDays` is cancelled by Studio, with that stated as the reason. Returns the
 * cancellation when the rule applies at `now`, otherwise `null`.
 */
export function longWaitCancellation(run: Run, now: Date): RunCancellation | null {
  if (run.state !== 'waiting_for_operator' || run.waitingSince === null) return null;
  const limitMs = run.limits.waitingDays * 24 * 60 * 60 * 1000;
  if (now.getTime() - run.waitingSince.getTime() <= limitMs) return null;
  const days = run.limits.waitingDays;
  return {
    by: 'system',
    reason: `Cancelled automatically: the run waited for the operator longer than ${days} ${days === 1 ? 'day' : 'days'}.`,
  };
}

/**
 * Studio's backstop for the step time limit (review of #121): the agent worker stops a Run step
 * at `stepMinutes`; if a `running` Run's step is still going this much later, Studio itself ends
 * the Run as `timed_out`.
 */
export const STEP_TIME_LIMIT_GRACE_MINUTES = 5;

/**
 * The failure of a Run that would exceed its maximum number of Run steps (Issue #100); in a
 * Follow-up the allowance is the Follow-up's own (Issue #141).
 */
export function stepLimitFailure(maxSteps: number, inFollowUp = false): RunFailure {
  const steps = `${maxSteps} run ${maxSteps === 1 ? 'step' : 'steps'}`;
  return {
    code: 'step_limit',
    detail: inFollowUp
      ? `The Follow-up reached its limit of ${steps}; no further step was started.`
      : `The run reached its limit of ${steps}; no further step was started.`,
  };
}

/** Why a resumed Run step continues the agent session (Issue #141; the worker protocol's list). */
export const RESUME_REASONS = ['answer', 'usage_limit', 'follow_up'] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

/**
 * The message that resumes the Run's agent session, and why (Issue #103, #105, #141): the
 * operator's latest message while it is the last one and the Run has a session reference;
 * otherwise `null`. A Follow-up resumes as `follow_up`; an answer right after the agent's
 * question as `answer`; any other answer is the usage-limit resume's "Continue where you
 * stopped." (`usage_limit`). A resumed step that asks again adds a question after it, so it is
 * never handed out twice.
 */
export function resumeMessage(
  run: Pick<Run, 'sessionRef' | 'messages'>,
): { text: string; reason: ResumeReason } | null {
  const last = run.messages.at(-1);
  if (run.sessionRef === null || last === undefined) return null;
  if (last.kind === 'question' || last.kind === 'part_end') return null;
  if (last.kind === 'follow_up') return { text: last.text, reason: 'follow_up' };
  const before = run.messages.at(-2);
  return { text: last.text, reason: before?.kind === 'question' ? 'answer' : 'usage_limit' };
}

/**
 * Whether a resume claim takes a new snapshot of the Project's Environment file (review S3 of
 * #150): a Follow-up, and a usage-limit resume inside one, work with the Project's current file
 * (or none), snapshotted at the claim as at a Run's start.
 */
export function takesNewEnvironmentFile(
  run: Pick<Run, 'followUpCount'>,
  reason: ResumeReason,
): boolean {
  return reason === 'follow_up' || (reason === 'usage_limit' && run.followUpCount > 0);
}

/**
 * Whether the Run waits in the queue to be resumed (Issue #103): the operator answered (or sent
 * a Follow-up, Issue #141), and the agent worker that holds its Working copy has not claimed it.
 */
export function isResumable(run: Pick<Run, 'state' | 'sessionRef' | 'messages'>): boolean {
  return run.state === 'queued' && resumeMessage(run) !== null;
}

/**
 * Why a Run cannot take a Follow-up now (Issue #141): it is not finished (queued, preparing,
 * running, waiting for the operator, or its delivery is being retried), a Follow-up is already
 * queued, its Working copy was removed (or it never reported one), it has no agent session, it
 * reached its Run step total, its Provider is unavailable, or the agent worker that holds its
 * Working copy is not connected. Issue #142: or its pull request, as last read, was merged or
 * closed, or was not found (`pull_request_missing`: gone, or not visible to the Agent account); a pull request
 * of unknown state does not stop it.
 */
export const FOLLOW_UP_REFUSALS = [
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
] as const;
export type FollowUpRefusal = (typeof FOLLOW_UP_REFUSALS)[number];

export type FollowUpEligibility = { allowed: true } | { allowed: false; reason: FollowUpRefusal };

/**
 * Whether the operator may send the Run a Follow-up (Issue #141): the one way from a final state
 * back to `queued`, next to {@link canRetryDelivery} and {@link canResumeAfterUsageLimit}. A
 * finished Run (succeeded, failed, timed out or cancelled) that no worker holds, whose Working
 * copy and agent session exist, below its Run step total, with its Provider available on the
 * connected agent worker that holds the Working copy. `context` is what Studio knows about the
 * agent worker now.
 */
export function followUpEligibility(
  run: Pick<
    Run,
    | 'state'
    | 'followUpQueued'
    | 'claimedBy'
    | 'deliveryRequested'
    | 'sessionRef'
    | 'workingCopy'
    | 'workingCopyRemovedAt'
    | 'stepCount'
    | 'limits'
    | 'pullRequestStatus'
  >,
  context: { workerAvailable: boolean; providerAvailable: boolean },
): FollowUpEligibility {
  const refuse = (reason: FollowUpRefusal): FollowUpEligibility => ({ allowed: false, reason });
  if (run.followUpQueued) return refuse('follow_up_queued');
  if (!isFinal(run.state) || run.claimedBy !== null || run.deliveryRequested) {
    return refuse('not_finished');
  }
  // Issue #142: nothing to update once the pull request is over; a reopened one is open again
  // at the next lookup.
  const pullRequest = run.pullRequestStatus.state;
  if (pullRequest !== null && pullRequest in PULL_REQUEST_ENDED_REFUSALS) {
    return refuse(
      PULL_REQUEST_ENDED_REFUSALS[pullRequest as keyof typeof PULL_REQUEST_ENDED_REFUSALS],
    );
  }
  if (run.sessionRef === null) return refuse('no_session');
  if (run.workingCopy === null || run.workingCopyRemovedAt !== null) {
    return refuse('working_copy_removed');
  }
  if (run.stepCount >= run.limits.maxTotalSteps) return refuse('step_total_reached');
  if (!context.workerAvailable) return refuse('worker_unavailable');
  if (!context.providerAvailable) return refuse('provider_unavailable');
  return { allowed: true };
}

/** A Follow-up the Run cannot take now (Issue #141), with the reason. */
export class FollowUpNotAllowedError extends Error {
  constructor(readonly reason: FollowUpRefusal) {
    super(`The run cannot take a Follow-up now (${reason}).`);
    this.name = 'FollowUpNotAllowedError';
  }
}

/**
 * The message that resumes a Run stopped at the subscription's usage limit (Issue #105): sent
 * to the agent as the next message of its session, stored as the operator's answer.
 */
export const USAGE_LIMIT_RESUME_TEXT = 'Continue where you stopped.';

/**
 * Whether the operator may resume a Run stopped at the usage limit (Issue #105): `failed` with
 * `usage_limit`, with the agent session and the Working copy the worker reported, and no cancel
 * request. It goes back to `queued` and is resumed like an answered Run (same holder rules).
 */
export function canResumeAfterUsageLimit(
  run: Pick<Run, 'state' | 'failure' | 'sessionRef' | 'workingCopy' | 'cancelRequestedAt'>,
): boolean {
  return (
    run.state === 'failed' &&
    run.failure?.code === 'usage_limit' &&
    run.sessionRef !== null &&
    run.workingCopy !== null &&
    run.cancelRequestedAt === null
  );
}

/** Resuming a Run that did not stop at the usage limit with a session to resume (Issue #105). */
export class RunNotResumableError extends Error {
  constructor() {
    super('Only a run stopped at the usage limit, with an agent session, can be resumed.');
    this.name = 'RunNotResumableError';
  }
}

/**
 * Resuming a Run stopped at the usage limit while its place is taken (review R1 of #129):
 * another Run of its project is active, or the server's places are.
 */
export class RunSlotTakenError extends Error {
  constructor(readonly scope: 'project' | 'server') {
    super(
      scope === 'project'
        ? 'Another run of this project is active. Resume this run when that run has ended.'
        : `${MAX_ACTIVE_RUNS} runs are already active on the server. Resume this run when one of them has ended.`,
    );
    this.name = 'RunSlotTakenError';
  }
}

/** Answering a Run that is not waiting for the operator (Issue #103). */
export class RunNotWaitingError extends Error {
  constructor(readonly state: RunState) {
    super('The run is not waiting for an answer.');
    this.name = 'RunNotWaitingError';
  }
}

/**
 * The gone-worker rule for a resume (Issue #103): only the agent worker that started the Run
 * has its Working copy and the agent's session; when it has not reported for longer than the
 * lease (counted from when Studio started, if it never reported since), the answered Run fails.
 */
export function goneResumeWorkerRule(
  now: Date,
  leaseSeconds: number,
): { seenBefore: Date; failure: RunFailure } {
  return {
    seenBefore: new Date(now.getTime() - leaseSeconds * 1000),
    failure: {
      code: 'preparation_failed',
      detail:
        `Working copy no longer exists (agent worker gone) — run again: the agent worker that ` +
        `started this run has not reported for more than ${leaseSeconds} seconds.`,
    },
  };
}

/** Starting a Run: no project has this id. */
export class RunProjectNotFoundError extends Error {
  constructor() {
    super('The project does not exist.');
    this.name = 'RunProjectNotFoundError';
  }
}

/** Starting a Run: the project has no Repository, or its Repository is not `ready`. */
export class RepositoryNotReadyError extends Error {
  constructor(readonly reason: 'no_repository' | 'not_ready') {
    super(
      reason === 'no_repository'
        ? 'The project has no repository. Connect one before starting a run.'
        : "The project's repository is not ready. Wait until it is ready, then start the run.",
    );
    this.name = 'RepositoryNotReadyError';
  }
}

/**
 * The gone-worker rule for a requested delivery retry (Issue #102, review N2 of #122): only the
 * agent worker that started the Run has its Working copy; when it has not reported for longer
 * than the lease (counted from when Studio started, if it never reported since), the retry
 * fails with this failure and is released.
 */
export function goneWorkerRule(
  now: Date,
  leaseSeconds: number,
): { seenBefore: Date; failure: RunFailure } {
  return {
    seenBefore: new Date(now.getTime() - leaseSeconds * 1000),
    failure: {
      code: 'delivery_failed',
      detail:
        `Working copy no longer exists (agent worker gone): the agent worker that started this ` +
        `run has not reported for more than ${leaseSeconds} seconds.`,
    },
  };
}

/**
 * The lost-worker rule (Issue #96): a held Run whose last heartbeat is older than the lease
 * has lost its agent worker. Returns the cut-off and the failure it gets.
 */
export function lostWorkerRule(
  now: Date,
  leaseSeconds: number,
): { staleBefore: Date; failure: RunFailure; deliveryFailure: RunFailure } {
  return {
    staleBefore: new Date(now.getTime() - leaseSeconds * 1000),
    failure: {
      code: 'worker_lost',
      detail: `The agent worker sent no heartbeat for ${leaseSeconds} seconds.`,
    },
    // A delivery retry whose worker was lost stays a failed delivery, so it can be retried.
    deliveryFailure: {
      code: 'delivery_failed',
      detail:
        `The agent worker sent no heartbeat for ${leaseSeconds} seconds while it retried the ` +
        'delivery. Retry the delivery.',
    },
  };
}
