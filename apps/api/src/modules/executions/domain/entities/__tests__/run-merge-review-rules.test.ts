import { describe, expect, it } from 'vitest';
import { RunPullRequestStatus } from '../../value-objects/run-pull-request-status.js';
import type { PullRequestState } from '../../value-objects/pull-request-state.js';
import { Run } from '../run.js';
import { AT, runData } from './run-fixtures.js';

const PUSHED = 'a'.repeat(40);
const LOOKED = 'b'.repeat(40);
const FINISHED = new Date('2026-11-21T10:00:00.000Z');
const WORKING_COPY = { runBranch: 'agent/x-r0b8e5c2d', commits: [], hasUncommittedChanges: false };
const PULL_REQUEST = { url: 'https://github.com/acme/shop/pull/7', number: 7 };

function run(
  options: {
    delivered?: boolean;
    state?: PullRequestState | null;
    workingCopy?: boolean;
    pushedCommit?: string | null;
    lookedCommit?: string | null;
    refreshedAt?: Date | null;
    finishedAt?: Date | null;
  } = {},
) {
  const { delivered = true, state = 'open', workingCopy = true } = options;
  const status = RunPullRequestStatus.none().toData();
  return Run.restore(
    runData({
      state: 'succeeded',
      workingCopy: workingCopy ? WORKING_COPY : null,
      delivery: delivered ? 'delivered' : null,
      pullRequest: delivered ? PULL_REQUEST : null,
      pushedCommit: options.pushedCommit ?? null,
      finishedAt: options.finishedAt ?? FINISHED,
      pullRequestStatus: {
        ...status,
        state,
        refreshedAt: options.refreshedAt ?? null,
        checks: options.lookedCommit == null ? null : { commit: options.lookedCommit, checks: [] },
      },
    }),
  );
}

describe('Run: merge review rules', () => {
  describe('refusal', () => {
    it.each<PullRequestState | null>(['open', 'draft', null])(
      'allows a review while the pull request is %s',
      (state) => {
        expect(run({ state }).mergeReviewRefusal()).toBeNull();
      },
    );

    it.each<PullRequestState>(['merged', 'closed', 'missing'])(
      'refuses a pull request that is %s',
      (state) => {
        expect(run({ state }).mergeReviewRefusal()).toBe('pull_request_not_open');
      },
    );

    it('refuses a Run without a pull request, and one whose Run branch is unknown', () => {
      expect(run({ delivered: false }).mergeReviewRefusal()).toBe('no_pull_request');
      expect(run({ workingCopy: false }).mergeReviewRefusal()).toBe('no_pull_request');
    });

    it('names the Run branch from the Working copy', () => {
      expect(run().runBranch).toBe('agent/x-r0b8e5c2d');
      expect(run({ workingCopy: false }).runBranch).toBeNull();
    });
  });

  describe('latest known head', () => {
    it('is the pushed commit when no lookup read the pull request', () => {
      expect(run({ pushedCommit: PUSHED }).latestKnownHead()).toBe(PUSHED);
    });

    it('is the lookup’s head when nothing was pushed', () => {
      expect(
        run({ lookedCommit: LOOKED, refreshedAt: new Date(AT.getTime()) }).latestKnownHead(),
      ).toBe(LOOKED);
    });

    it('is the lookup’s head when it was read after the Run last finished', () => {
      const refreshedAt = new Date(FINISHED.getTime() + 60_000);

      expect(
        run({ pushedCommit: PUSHED, lookedCommit: LOOKED, refreshedAt }).latestKnownHead(),
      ).toBe(LOOKED);
    });

    it('is the pushed commit when the lookup was read before the Run last finished', () => {
      const refreshedAt = new Date(FINISHED.getTime() - 60_000);

      expect(
        run({ pushedCommit: PUSHED, lookedCommit: LOOKED, refreshedAt }).latestKnownHead(),
      ).toBe(PUSHED);
    });

    it('is unknown with neither', () => {
      expect(run().latestKnownHead()).toBeNull();
    });
  });
});
