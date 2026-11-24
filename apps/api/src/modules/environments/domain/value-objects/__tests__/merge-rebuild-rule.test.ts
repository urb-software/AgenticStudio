import { describe, expect, it } from 'vitest';
import {
  type MergeRebuildRuleFacts,
  MergeRebuildRule,
  type MergeRebuildRuleSource,
} from '../merge-rebuild-rule.js';

const MERGED = 'e'.repeat(40);
const OLD = 'a'.repeat(40);
const RECORDED = new Date('2026-11-24T10:00:00.000Z');
const FETCH_STARTED = new Date('2026-11-24T10:00:01.000Z');
const minutes = (count: number) => new Date(RECORDED.getTime() + count * 60_000);

const ready = (commit: string, fetchedAt: Date | null): MergeRebuildRuleSource => ({
  ready: true,
  commit,
  fetchedAt,
});

function facts(overrides: Partial<MergeRebuildRuleFacts> = {}): MergeRebuildRuleFacts {
  return {
    state: 'running',
    runningCommit: OLD,
    source: ready(MERGED, FETCH_STARTED),
    rebuild: { mergedCommit: MERGED, fetchStartedAt: FETCH_STARTED, recordedAt: RECORDED },
    now: minutes(1),
    ...overrides,
  };
}

const decide = (overrides: Partial<MergeRebuildRuleFacts> = {}) =>
  MergeRebuildRule.create().decide(facts(overrides));

describe('MergeRebuildRule', () => {
  describe('build', () => {
    it('builds once the Clone is at the merged commit and the Preview runs another', () => {
      expect(decide()).toEqual({ action: 'build' });
    });

    it('builds when a fetch finished at or after the start of the merge fetch', () => {
      const source = ready('f'.repeat(40), FETCH_STARTED);

      expect(decide({ source })).toEqual({ action: 'build' });
      expect(
        decide({ source: ready('f'.repeat(40), new Date(FETCH_STARTED.getTime() + 1)) }),
      ).toEqual({ action: 'build' });
    });

    it('builds when the Clone is at the merged commit even if the fetch time is unknown', () => {
      expect(decide({ source: ready(MERGED, null) })).toEqual({ action: 'build' });
    });
  });

  describe('wait', () => {
    it('waits for a fetch that finished before the merge fetch started', () => {
      const source = ready(OLD, new Date(FETCH_STARTED.getTime() - 1));

      expect(decide({ source })).toEqual({ action: 'wait', reason: 'clone_fetch' });
      expect(decide({ source: ready(OLD, null) })).toEqual({
        action: 'wait',
        reason: 'clone_fetch',
      });
    });

    it('waits while the Clone is not ready', () => {
      expect(decide({ source: { ready: false } })).toEqual({
        action: 'wait',
        reason: 'clone_not_ready',
      });
    });

    it('waits while a build or a change is active', () => {
      expect(decide({ state: 'building' })).toEqual({ action: 'wait', reason: 'build_active' });
      expect(decide({ state: 'stopping' })).toEqual({ action: 'wait', reason: 'change_active' });
      expect(decide({ state: 'resetting_data' })).toEqual({
        action: 'wait',
        reason: 'change_active',
      });
    });

    it('waits for the Clone even when it holds what runs, until it holds the merge', () => {
      const source = ready(OLD, new Date(FETCH_STARTED.getTime() - 1));

      expect(decide({ runningCommit: OLD, source })).toEqual({
        action: 'wait',
        reason: 'clone_fetch',
      });
    });
  });

  describe('drop', () => {
    it.each(['stopped', 'failed', 'not_configured'] as const)(
      'drops the rebuild when the Preview is %s',
      (state) => {
        expect(decide({ state, runningCommit: null })).toEqual({ action: 'drop' });
      },
    );

    it('drops the rebuild when the running commit already is the Clone commit', () => {
      expect(decide({ runningCommit: MERGED })).toEqual({ action: 'drop' });
    });
  });

  describe('give up', () => {
    it('gives up 30 minutes after the recording, with what it waited for', () => {
      const source = ready(OLD, null);

      expect(decide({ source, now: minutes(29) })).toEqual({
        action: 'wait',
        reason: 'clone_fetch',
      });
      expect(decide({ source, now: minutes(30) })).toEqual({
        action: 'give_up',
        reason:
          'The rebuild did not start within 30 minutes: ' +
          'it was waiting for the Clone fetch to bring in the merge.',
      });
    });

    it.each([
      ['building', 'the running build to finish'],
      ['stopping', 'a stop or data removal to finish'],
    ] as const)('names the reason when the Preview is %s', (state, text) => {
      expect(decide({ state, now: minutes(31) })).toMatchObject({
        action: 'give_up',
        reason: expect.stringContaining(text) as string,
      });
    });

    it('does not give up a rebuild it can build or drop', () => {
      expect(decide({ now: minutes(90) })).toEqual({ action: 'build' });
      expect(decide({ runningCommit: MERGED, now: minutes(90) })).toEqual({ action: 'drop' });
    });

    it('gives up a refused wait the same way', () => {
      const rule = MergeRebuildRule.create();
      const rebuild = { recordedAt: RECORDED };

      expect(rule.waiting(rebuild, minutes(5), 'controller')).toEqual({
        action: 'wait',
        reason: 'controller',
      });
      expect(rule.waiting(rebuild, minutes(30), 'controller')).toMatchObject({
        action: 'give_up',
        reason: expect.stringContaining('an environment controller') as string,
      });
    });
  });
});
