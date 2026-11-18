import type { FollowUpEligibility } from './follow-up.js';
import { isEndedPullRequestState, type PullRequestState } from './run-pull-request-status.js';
import { isFinalRunState, type RunState } from './run-state.js';
import { WorkerStatus, type RecordedWorkerStatus } from './worker-status.js';

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
 * The periods and limits of the `STUDIO_RETENTION_*` settings (Issue #143), as plain values to
 * build a {@link RetentionPolicy} from.
 */
export interface RetentionSettings {
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

/** One final Run of a Project that the limit counts. */
export interface LimitedRun {
  runId: string;
  projectId: string;
  finishedAt: Date;
}

/**
 * A Run's Follow-up eligibility with, when the Run is open to one, until when (Issue #143), or
 * that its removal is pending: its date passed, or the per-Project limit removes it, and the
 * agent worker's next hourly sweep takes the Working copy.
 */
export type FollowUpView = FollowUpEligibility & { openUntil?: Date; removalPending?: true };

/**
 * How long a finished Run's Working copy is kept (Issue #143, ADR 0002): the periods and limits
 * of the `STUDIO_RETENTION_*` settings, answering for a Run's {@link RetentionFacts}. Studio
 * decides; the agent worker removes what Studio says.
 */
export class RetentionPolicy {
  readonly days: number;
  readonly maxPerProject: number;
  readonly openPullRequestIdleDays: number;
  readonly hoursAfterPullRequestEnd: number;

  private constructor(settings: RetentionSettings) {
    this.days = settings.days;
    this.maxPerProject = settings.maxPerProject;
    this.openPullRequestIdleDays = settings.openPullRequestIdleDays;
    this.hoursAfterPullRequestEnd = settings.hoursAfterPullRequestEnd;
  }

  static of(settings: RetentionSettings): RetentionPolicy {
    return new RetentionPolicy(settings);
  }

  /**
   * Until when a Run's Working copy is kept at least (Issue #143, ADR 0002), or `null` when it is
   * not a candidate for removal at all (the Run is not final: queued, preparing, running or
   * waiting for the operator).
   * - A Run with a pull request: the earlier of the pull request's end plus
   *   `hoursAfterPullRequestEnd`, and the last activity plus `openPullRequestIdleDays`. A pull
   *   request that is open, draft or of unknown state has no end. The per-Project limit never
   *   applies to it.
   * - Any other Run: `days` after it finished (its latest result); the per-Project limit applies
   *   ({@link RetentionPolicy.isLimited}, {@link RetentionPolicy.overLimit}).
   */
  keepUntil(facts: RetentionFacts): Date | null {
    if (!isFinalRunState(facts.state) || facts.finishedAt === null) return null;
    if (!facts.hasPullRequest) {
      return new Date(facts.finishedAt.getTime() + this.days * DAY_MS);
    }
    const idleEnd = facts.lastActivityAt.getTime() + this.openPullRequestIdleDays * DAY_MS;
    if (!isEndedPullRequestState(facts.pullRequestState) || facts.pullRequestEndedAt === null) {
      return new Date(idleEnd);
    }
    return new Date(
      Math.min(
        idleEnd,
        facts.pullRequestEndedAt.getTime() + this.hoursAfterPullRequestEnd * HOUR_MS,
      ),
    );
  }

  /** Whether the per-Project limit counts (and may remove) this Run: a final Run without a pull request. */
  isLimited(facts: Pick<RetentionFacts, 'state' | 'hasPullRequest'>): boolean {
    return isFinalRunState(facts.state) && !facts.hasPullRequest;
  }

  /**
   * The Runs the per-Project limit removes (Issue #143): of each Project's limited Runs, all but
   * the newest `maxPerProject` by finish time. A Run with a pull request is never in `runs`.
   */
  overLimit(runs: readonly LimitedRun[]): Set<string> {
    const byProject = new Map<string, LimitedRun[]>();
    for (const run of runs) {
      byProject.set(run.projectId, [...(byProject.get(run.projectId) ?? []), run]);
    }
    const over = new Set<string>();
    for (const projectRuns of byProject.values()) {
      projectRuns.sort(
        (a, b) => b.finishedAt.getTime() - a.finishedAt.getTime() || a.runId.localeCompare(b.runId),
      );
      for (const run of projectRuns.slice(this.maxPerProject)) over.add(run.runId);
    }
    return over;
  }

  /**
   * What the single-Run answers (the Run page, the refresh, the Follow-up command and the
   * preparation of failing checks) add to a Run: whether it can take a Follow-up now and until
   * when it stays open to one, and whether any agent worker is connected (Issues #141, #142,
   * #143). The handler fetched `latestWorker` (the latest report of any agent worker) and
   * `overLimit` (the per-Project limit removes the Run), and took `eligibility` and `facts`
   * from the Run.
   */
  runView(
    eligibility: FollowUpEligibility,
    facts: RetentionFacts,
    latestWorker: RecordedWorkerStatus | undefined,
    now: Date,
    leaseSeconds: number,
    overLimit: boolean,
  ): { followUp: FollowUpView; workerConnected: boolean } {
    return {
      followUp: this.followUpView(eligibility, facts, overLimit, now),
      workerConnected: WorkerStatus.isAnyConnected(latestWorker, now, leaseSeconds),
    };
  }

  /**
   * A Run's Follow-up eligibility with, when the Run is open to one, until when it stays open
   * (Issue #143): it can take one now, or only waits for its worker or Provider to be available.
   * Not once the Working copy is gone, the pull request is over, or the Run is not finished.
   * `overLimit`: the per-Project limit removes it.
   */
  followUpView(
    eligibility: FollowUpEligibility,
    facts: RetentionFacts,
    overLimit: boolean,
    now: Date,
  ): FollowUpView {
    const open =
      eligibility.allowed ||
      eligibility.reason === 'worker_unavailable' ||
      eligibility.reason === 'provider_unavailable';
    const until = open ? this.keepUntil(facts) : null;
    if (until === null) return { ...eligibility };
    return {
      ...eligibility,
      ...(overLimit || until.getTime() <= now.getTime()
        ? { removalPending: true as const }
        : { openUntil: until }),
    };
  }
}
