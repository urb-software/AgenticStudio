import type { RunStepSnapshot } from '../entities/run-step.js';
import type { FollowUpComments, FollowUpSource } from './follow-up.js';
import type { Provider } from './provider.js';
import type { BringUpDetails, RunMessage, RunQuestion } from './run-conversation.js';
import type { RunData } from './run-data.js';
import type { RunDeliveryOutcome } from './run-delivery.js';
import type { RunFailure } from './run-failure.js';
import type { RunLimits } from './run-limits.js';
import type { PullRequestState } from './run-pull-request-status.js';
import type { RunState } from './run-state.js';
import type { RunStepKind } from './run-step-kind.js';
import type { RunWorkingCopy } from './run-working-copy.js';
import type { Task } from './task.js';
import type { RecordedWorkerStatus } from './worker-status.js';

/** What a new Run is started from (Issue #96). */
export interface RunStartInput {
  id: string;
  projectId: string;
  provider: Provider;
  task: Task;
  startCommit: string;
  remoteUrl: string;
  integrationBranch: string;
  /** The limits in force when the Run is started (Issue #100). */
  limits: RunLimits;
  /**
   * The Run's creation and first activity as the object sees them. The store does not take them:
   * it assigns `created_at` itself, so the queue order (creation time, then id) uses one clock
   * (Issue #169), and the Run it returns carries the stored time.
   */
  now: Date;
}

/**
 * What the Run's handler fetched about the agent workers, as values (Issue #141): when the worker
 * that holds the Run's Working copy (its last claimer) last reported, and the latest report of
 * any worker.
 */
export interface WorkerFacts {
  /** The last report of the Run's last claimer; `undefined`: none, or the Run was never claimed. */
  holderLastSeen: Date | undefined;
  /** The latest report of any agent worker; `undefined`: none. */
  latest: RecordedWorkerStatus | undefined;
}

/** What the Run needs to know about the agent worker to take a Follow-up (Issue #141). */
export interface FollowUpFacts {
  /** The agent worker that holds the Run's Working copy reported within the lease. */
  workerAvailable: boolean;
  /** The Run's Provider is available on the connected agent worker. */
  providerAvailable: boolean;
}

/** What Studio knows about a Run that decides how long its Working copy is kept (Issue #143). */
export interface RetentionFacts {
  state: RunState;
  /** Set exactly in a final state. */
  finishedAt: Date | null;
  /** Whether the Run has a pull request (it was delivered). */
  hasPullRequest: boolean;
  /**
   * The pull request's state as last read. `null` (never read, or a lookup that never succeeded)
   * counts as open: a Git host outage never causes removal.
   */
  pullRequestState: PullRequestState | null;
  /** When the pull request was first read as merged, closed or missing; `null` while it is not. */
  pullRequestEndedAt: Date | null;
  /** The latest Run step, Answer or Follow-up (or the Run's creation). */
  lastActivityAt: Date;
}

/**
 * What the Run needs to know about the places held, and about its Environment file snapshot, to
 * be resumed after the usage limit (Issue #105, review R1 of #129). The store reads them under
 * the lock that serializes claims, so they cannot change before the change is saved.
 */
export interface ResumeFacts {
  /** Another Run of the Run's Project holds a place: active, held for a retry, or queued to resume. */
  projectPlaceTaken: boolean;
  /** How many other Runs hold a place across the server. */
  serverPlacesTaken: number;
  /** The Run's Environment file snapshot (its secret) still exists. */
  environmentFileSnapshotKept: boolean;
}

/**
 * Where a Follow-up's text came from, when it was prepared (Issue #145, #147, #146): the source, and
 * for `review_comments` what the operator's selection came to in the Run's loaded Review comments,
 * as values the handler read under the Run's lock (how many, and whose); `null` when the selected
 * comments are not all in the loaded set.
 */
export type FollowUpOrigin =
  | Exclude<FollowUpSource, 'review_comments'>
  | { source: 'review_comments'; comments: FollowUpComments | null };

/**
 * What a Follow-up used up beyond the Run: the prepared Follow-up of its source (Issue #145), or the
 * loaded Review comments it was prepared from (Issue #146). The caller removes it in the same
 * transaction that saves the Run.
 */
export type FollowUpConsumption = Exclude<FollowUpSource, 'bring_up_to_date'>;

/** One reported Run step: its kind and the structured result, as validated JSON. */
export interface RunStepRecord {
  kind: RunStepKind;
  result: unknown;
  /** The step's number as the worker reports it (review of #121); the next one when absent. */
  index?: number;
  /** A `needs_input` step's question (Issue #103): stored as the Run's next message. */
  question?: RunQuestion;
  /** The agent session the step reported (Issue #103): becomes the Run's session reference. */
  sessionRef?: string;
}

/** What storing a reported Run step did (Issue #100: the Run also enforces the step limit). */
export type RunStepOutcome =
  /** Stored now, or (`duplicate`) already stored by an earlier delivery of the same report. */
  | { status: 'stored'; index: number; duplicate?: boolean }
  /** The step would exceed the Run's `maxSteps`: it was not stored, and the Run is now `failed`. */
  | { status: 'step_limit' };

/**
 * What an agent worker reports about a change of a Run's state (Issues #96, #102, #105, #147):
 * the state it reached, with how it ended and what it knows of the Working copy.
 */
export interface RunStateReport {
  /** One of the states a worker reports (the shared contract restricts it). */
  state: RunState;
  /** Exactly when `state` is `failed`. */
  failure: RunFailure | null;
  /** A failed Run's Working copy state, when the worker could read it (Issue #98). */
  workingCopy?: RunWorkingCopy | null;
  /** With `succeeded`: how the Run was delivered (Issue #102). */
  delivery?: RunDeliveryOutcome | null;
  /** With `failed` / `usage_limit`: the agent session to resume later (Issue #105). */
  sessionRef?: string | null;
  /** With `failed` / `delivery_failed`: what the delivery pushed before it failed (#141, S2). */
  pushedCommit?: string | null;
  /**
   * With `running` of a bring-up-to-date Follow-up (Issue #147): where the merge started, kept on
   * its conversation entry for the later claims of the part.
   */
  bringUpToDateStarted?: { baseCommit: string; integrationCommit: string } | null;
  /**
   * With `succeeded` and a bring-up-to-date Follow-up (Issue #147): the request changed nothing;
   * the Run returns to the result it had before it. `unchangedDetail` says why (default: the
   * branch was already up to date).
   */
  unchanged?: boolean;
  unchangedDetail?: string | null;
}

/**
 * What changed on a Run since it was started or restored, for the store to save in one step
 * (Issue #167): the new values of the changed fields, the messages added to the conversation and
 * the Run steps it created.
 */
export interface RunChanges {
  fields: Partial<Omit<RunData, 'messages'>>;
  messages: RunMessage[];
  /** Run steps to store (Issue #169): the child entities the Run created, as their snapshots. */
  steps?: RunStepSnapshot[];
  /** What a bring-up-to-date request records on its latest Follow-up entry (Issue #147). */
  followUpEntry?: BringUpDetails;
  /** The secret store's reference to the Run's Environment file snapshot (Issue #104). */
  environmentFileSecretRef?: string | null;
}
