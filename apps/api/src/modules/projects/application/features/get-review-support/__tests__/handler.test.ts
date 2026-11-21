import { describe, expect, it } from 'vitest';
import { FakeRepositoryGit } from '../../../ports/__tests__/fake-repository-git.js';
import { GetReviewSupportHandler } from '../handler.js';

describe('GetReviewSupportHandler', () => {
  it('says reviews are supported where Git operations are', () => {
    expect(new GetReviewSupportHandler(new FakeRepositoryGit()).execute({})).toEqual({
      supported: true,
    });
  });

  it('says they are not supported where the platform is not Linux', () => {
    const git = new FakeRepositoryGit();
    git.supported = false;

    expect(new GetReviewSupportHandler(git).execute({})).toEqual({ supported: false });
  });
});
