import type { FollowUpEligibility } from './follow-up-eligibility.js';
import { isEndedPullRequestState } from './pull-request-state.js';
import { isFinalRunState } from './run-state.js';
import { Lease } from './lease.js';
import { WorkerPresence } from './worker-presence.js';
import { type WorkerStatusData } from './worker-status-data.js';
import type { RetentionFacts } from './retention-facts.js';
import type { RetentionSettings } from './retention-settings.js';
import type { LimitedRunFacts } from './limited-run-facts.js';
import type { LimitedRun } from './limited-run.js';
import type { FollowUpView } from './follow-up-view.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

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
   * `null` when the Run is not final. With a pull request: the earlier of its end plus
   * `hoursAfterPullRequestEnd` and the last activity plus `openPullRequestIdleDays`. Otherwise
   * `days` after it finished.
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

  isLimited(facts: Pick<RetentionFacts, 'state' | 'hasPullRequest'>): boolean {
    return isFinalRunState(facts.state) && !facts.hasPullRequest;
  }

  /** What the per-Project limit counts; `isLimited` is the cheap first check. */
  countsAgainstLimit(facts: LimitedRunFacts): boolean {
    return (
      this.isLimited(facts) &&
      facts.finishedAt !== null &&
      facts.hasWorkingCopy &&
      !facts.workingCopyRemoved
    );
  }

  /** Takes only final Runs without a pull request and without a removed Working copy. */
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

  runView(
    eligibility: FollowUpEligibility,
    facts: RetentionFacts,
    latestWorker: WorkerStatusData | undefined,
    now: Date,
    leaseSeconds: number,
    overLimit: boolean,
  ): { followUp: FollowUpView; workerConnected: boolean } {
    return {
      followUp: this.followUpView(eligibility, facts, overLimit, now),
      workerConnected: WorkerPresence.of(
        latestWorker,
        Lease.ofSeconds(leaseSeconds),
      ).isAnyConnected(now),
    };
  }

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
