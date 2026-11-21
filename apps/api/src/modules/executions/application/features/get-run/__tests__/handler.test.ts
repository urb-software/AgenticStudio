import { describe, expect, it } from 'vitest';
import { inMemoryExecutions } from '../../../__tests__/in-memory-executions.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import { deliveredRun, T0 } from '../../../../domain/repositories/__tests__/delivered-run.js';
import { RetentionPolicy } from '../../../../domain/value-objects/retention-policy.js';
import type { MergeSettings } from '../../../ports/merge-settings.js';
import { GetRunHandler } from '../handler.js';

async function answerWith(settings: MergeSettings) {
  const runs = new InMemoryRunRepository();
  const run = await deliveredRun(runs);
  const handler = new GetRunHandler(
    runs,
    { now: () => T0 },
    { record: () => undefined, latest: () => undefined, lastSeen: () => undefined },
    inMemoryExecutions(runs).preparedFollowUps,
    { seconds: 60 },
    RetentionPolicy.of({
      days: 7,
      maxPerProject: 10,
      openPullRequestIdleDays: 30,
      hoursAfterPullRequestEnd: 24,
    }),
    settings,
  );
  return handler.execute({ runId: run.id });
}

describe('GetRunHandler merge availability', () => {
  it('is available with the credential set for a GitHub remote', async () => {
    const answer = await answerWith({ configured: true, allowFileRemotes: false });
    expect(answer.merge).toEqual({ available: true });
  });

  it('says why merging is off while the credential is unset', async () => {
    const answer = await answerWith({ configured: false, allowFileRemotes: false });
    expect(answer.merge).toEqual({ available: false, reason: 'not_configured' });
  });
});
