import { describe, expect, it } from 'vitest';
import type { PullRequestScope } from '../../../application/ports/merge-host.js';
import { InMemoryMergeHost } from '../in-memory-merge-host.js';

const SCOPE: PullRequestScope = {
  remoteUrl: 'https://github.com/acme/shop.git',
  runBranch: 'agent/x-r0b8e5c2d',
  pullRequestNumber: 7,
};

describe('InMemoryMergeHost', () => {
  it('records every call with its arguments', async () => {
    const host = new InMemoryMergeHost();
    await host.readPullRequest(SCOPE);
    await host.readChecks(SCOPE, 'c'.repeat(40));
    await host.approve(SCOPE, 'c'.repeat(40));
    expect(host.calls.map((call) => call.method)).toEqual([
      'readPullRequest',
      'readChecks',
      'approve',
    ]);
    expect(host.calls[1]).toMatchObject({ scope: SCOPE, sha: 'c'.repeat(40) });
  });

  it('answers the pull request state and checks it was given', async () => {
    const host = new InMemoryMergeHost();
    host.setPullRequest({ draft: true, headSha: 'd'.repeat(40) });
    host.setChecks([{ name: 'build', state: 'pending' }]);
    expect(await host.readPullRequest(SCOPE)).toMatchObject({
      pullRequest: { draft: true, headSha: 'd'.repeat(40), state: 'open' },
    });
    expect(await host.readChecks(SCOPE, 'd'.repeat(40))).toEqual({
      ok: true,
      checks: [{ name: 'build', state: 'pending' }],
    });
  });

  it('refuses a merge of a commit that is not the head, as the host would', async () => {
    const host = new InMemoryMergeHost();
    const result = await host.merge(SCOPE, { sha: 'e'.repeat(40), method: 'squash' });
    expect(result).toMatchObject({ ok: false, failure: { code: 'refused' } });
    expect((await host.readPullRequest(SCOPE)).ok && host.calls.length).toBe(2);
  });

  it('merges the head, closes and deletes the Run branch', async () => {
    const host = new InMemoryMergeHost();
    host.setPullRequest({ headSha: 'a'.repeat(40) });
    expect(await host.merge(SCOPE, { sha: 'a'.repeat(40), method: 'merge_commit' })).toEqual({
      ok: true,
    });
    expect(await host.readPullRequest(SCOPE)).toMatchObject({ pullRequest: { state: 'merged' } });
    await host.close(SCOPE);
    await host.deleteRunBranch(SCOPE);
    expect(host.runBranchDeleted).toBe(true);
  });

  it('answers a failure set for a method, until it is removed', async () => {
    const host = new InMemoryMergeHost();
    host.refuse('close', { code: 'rate_limited', retryAfterSeconds: 30 });
    expect(await host.close(SCOPE)).toEqual({
      ok: false,
      failure: { code: 'rate_limited', retryAfterSeconds: 30 },
    });
    host.refuse('close', null);
    expect(await host.close(SCOPE)).toEqual({ ok: true });
  });
});
