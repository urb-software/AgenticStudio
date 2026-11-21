import { vi } from 'vitest';
import type {
  RunBranchReviews,
  RunStartPoint,
  RunStartPoints,
} from '../../../projects/contracts/index.js';

/** A scripted {@link RunBranchReviews}: the review fetches and computes unless a test overrides it. */
export class FakeRunBranchReviews implements RunBranchReviews {
  platformSupported = true;

  supported(): boolean {
    return this.platformSupported;
  }

  fetchForReview = vi.fn<RunBranchReviews['fetchForReview']>(() =>
    Promise.resolve({
      status: 'ready' as const,
      runCommit: 'b'.repeat(40),
      integrationCommit: 'a'.repeat(40),
    }),
  );

  mergeDiff = vi.fn<RunBranchReviews['mergeDiff']>(() =>
    Promise.resolve({
      status: 'computed' as const,
      files: [{ path: 'src/a.txt', status: 'added' as const, patch: '+a\n', cut: false }],
      truncated: false,
    }),
  );
}

/** A scripted {@link RunStartPoints}: every project's Repository is ready unless set otherwise. */
export class FakeRunStartPoints implements RunStartPoints {
  point: RunStartPoint = {
    status: 'ready',
    startCommit: 'a'.repeat(40),
    remoteUrl: 'https://github.com/acme/shop.git',
    integrationBranch: 'dev',
  };

  forProject(): Promise<RunStartPoint> {
    return Promise.resolve(this.point);
  }
}
