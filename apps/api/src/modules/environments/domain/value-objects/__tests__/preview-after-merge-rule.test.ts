import { describe, expect, it } from 'vitest';
import {
  type PreviewAfterMergeRuleFacts,
  PreviewAfterMergeRule,
} from '../preview-after-merge-rule.js';

const RUN = '3c1d8f2a-0b2f-4d6e-8a44-6b3c1d8f2a10';
const OTHER_RUN = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const BUILD = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';

const state = (overrides: Partial<PreviewAfterMergeRuleFacts> = {}) =>
  PreviewAfterMergeRule.create().state({
    runId: RUN,
    configured: true,
    runningBuildId: null,
    rebuild: null,
    build: null,
    ...overrides,
  });

describe('PreviewAfterMergeRule', () => {
  it('is not configured without settings, whatever else is known', () => {
    expect(state({ configured: false, build: { id: BUILD, status: 'succeeded' } })).toBe(
      'not_configured',
    );
  });

  it('is not started when nothing was recorded or built for the merge', () => {
    expect(state()).toBe('not_started');
  });

  it('waits while the rebuild of this Run waits, and failed once it failed', () => {
    expect(state({ rebuild: { runId: RUN, failed: false } })).toBe('waiting');
    expect(state({ rebuild: { runId: RUN, failed: true } })).toBe('failed');
  });

  it('is replaced when a newer merge holds the rebuild', () => {
    expect(state({ rebuild: { runId: OTHER_RUN, failed: false } })).toBe('replaced');
  });

  it.each([
    ['requested', 'building'],
    ['claimed', 'building'],
    ['failed', 'failed'],
  ] as const)('reads a build that is %s as %s', (status, expected) => {
    expect(state({ build: { id: BUILD, status } })).toBe(expected);
  });

  it('runs while the succeeded build is what the Preview runs, and is replaced after', () => {
    const build = { id: BUILD, status: 'succeeded' };

    expect(state({ build, runningBuildId: BUILD })).toBe('running');
    expect(state({ build, runningBuildId: OTHER_RUN })).toBe('replaced');
    expect(state({ build, runningBuildId: null })).toBe('replaced');
  });

  it('reports the build of this merge over the rebuild of a newer one', () => {
    expect(
      state({
        build: { id: BUILD, status: 'claimed' },
        rebuild: { runId: OTHER_RUN, failed: false },
      }),
    ).toBe('building');
  });
});
