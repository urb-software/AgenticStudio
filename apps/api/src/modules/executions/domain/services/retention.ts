import {
  isFinal,
  isPullRequestEnded,
  type PullRequestState,
  type Run,
  type RunState,
} from '../entities/run.js';

/**
 * How long a finished Run's Working copy is kept (Issue #143): the periods and limits of the
 * `STUDIO_RETENTION_*` settings. Studio decides; the agent worker removes what Studio says.
 */
export interface RetentionPolicy {
  /** A finished Run without a pull request keeps its Working copy this many days... */
  days: number;
  /** ...and at most this many such Runs per Project keep it. */
  maxPerProject: number;
  /** A Run with a pull request keeps it until this many days without activity... */
  openPullRequestIdleDays: number;
  /** ...or this many hours after the pull request was merged or closed, whichever is first. */
  hoursAfterPullRequestEnd: number;
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

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
 * Until when a Run's Working copy is kept at least (Issue #143, ADR 0002), or `null` when it is
 * not a candidate for removal at all (the Run is not final: queued, preparing, running or waiting
 * for the operator).
 * - A Run with a pull request: the earlier of the pull request's end plus
 *   `hoursAfterPullRequestEnd`, and the last activity plus `openPullRequestIdleDays`. A pull
 *   request that is open, draft or of unknown state has no end. The per-Project limit never
 *   applies to it.
 * - Any other Run: `days` after it finished (its latest result); the per-Project limit applies
 *   ({@link isLimited}, {@link overLimit}).
 */
export function keepUntil(facts: RetentionFacts, policy: RetentionPolicy): Date | null {
  if (!isFinal(facts.state) || facts.finishedAt === null) return null;
  if (!facts.hasPullRequest) {
    return new Date(facts.finishedAt.getTime() + policy.days * DAY_MS);
  }
  const idleEnd = facts.lastActivityAt.getTime() + policy.openPullRequestIdleDays * DAY_MS;
  if (!isPullRequestEnded(facts.pullRequestState) || facts.pullRequestEndedAt === null) {
    return new Date(idleEnd);
  }
  return new Date(
    Math.min(
      idleEnd,
      facts.pullRequestEndedAt.getTime() + policy.hoursAfterPullRequestEnd * HOUR_MS,
    ),
  );
}

/** Whether the per-Project limit counts (and may remove) this Run: a final Run without a pull request. */
export function isLimited(facts: Pick<RetentionFacts, 'state' | 'hasPullRequest'>): boolean {
  return isFinal(facts.state) && !facts.hasPullRequest;
}

/** One final Run of a Project that the limit counts. */
export interface LimitedRun {
  runId: string;
  projectId: string;
  finishedAt: Date;
}

/**
 * The Runs the per-Project limit removes (Issue #143): of each Project's limited Runs, all but
 * the newest `maxPerProject` by finish time. A Run with a pull request is never in `runs`.
 */
export function overLimit(runs: readonly LimitedRun[], maxPerProject: number): Set<string> {
  const byProject = new Map<string, LimitedRun[]>();
  for (const run of runs) {
    byProject.set(run.projectId, [...(byProject.get(run.projectId) ?? []), run]);
  }
  const over = new Set<string>();
  for (const projectRuns of byProject.values()) {
    projectRuns.sort(
      (a, b) => b.finishedAt.getTime() - a.finishedAt.getTime() || a.runId.localeCompare(b.runId),
    );
    for (const run of projectRuns.slice(maxPerProject)) over.add(run.runId);
  }
  return over;
}

/** The retention facts of a loaded Run. */
export function retentionFactsOf(run: Run): RetentionFacts {
  return {
    state: run.state,
    finishedAt: run.finishedAt,
    hasPullRequest: run.pullRequest !== null,
    pullRequestState: run.pullRequestStatus.state,
    pullRequestEndedAt: run.pullRequestStatus.endedAt,
    lastActivityAt: run.lastActivityAt,
  };
}
