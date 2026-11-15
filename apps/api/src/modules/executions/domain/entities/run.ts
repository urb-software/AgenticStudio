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

/** What an agent worker reports about a successful delivery. */
export type RunDeliveryOutcome =
  { outcome: 'none' } | { outcome: 'delivered'; pullRequest: RunPullRequest };

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
}

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['preparing', 'cancelled', 'timed_out'],
  preparing: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['waiting_for_operator', 'succeeded', 'failed', 'cancelled', 'timed_out'],
  waiting_for_operator: ['running', 'cancelled', 'timed_out'],
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
