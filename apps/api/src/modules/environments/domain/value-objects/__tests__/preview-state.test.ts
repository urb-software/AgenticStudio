import { describe, expect, it } from 'vitest';
import { PreviewState, type PreviewStateOperation } from '../preview-state.js';

const T = (minutes: number) => new Date(Date.UTC(2026, 10, 24, 10, minutes));

function build(
  id: string,
  status: 'requested' | 'claimed' | 'succeeded' | 'failed',
  commit = 'a'.repeat(40),
): PreviewStateOperation {
  const final = status === 'succeeded' || status === 'failed';
  return { id, kind: 'build', status, finishedAt: final ? T(5) : null, build: { commit } };
}

const other = (id: string, kind: 'stop' | 'remove_data'): PreviewStateOperation => ({
  id,
  kind,
  status: 'succeeded',
  finishedAt: T(9),
  build: null,
});

const state = (facts: Parameters<typeof PreviewState.of>[0]) => PreviewState.of(facts);

describe('PreviewState', () => {
  it('is not_configured without settings and without a build', () => {
    const result = state({ configured: false, latestBuild: null, runningChange: null });
    expect(result.name).toBe('not_configured');
    expect(result.running).toBeNull();
    expect(result.buildActive).toBe(false);
  });

  it('is stopped for settings that were never built', () => {
    expect(state({ configured: true, latestBuild: null, runningChange: null }).name).toBe(
      'stopped',
    );
  });

  it.each(['requested', 'claimed'] as const)(
    'is building while the latest build is %s',
    (status) => {
      const result = state({
        configured: true,
        latestBuild: build('b2', status),
        runningChange: null,
      });
      expect(result.name).toBe('building');
      expect(result.buildActive).toBe(true);
    },
  );

  it('is running after a succeeded build, with the commit and since', () => {
    const ok = build('b1', 'succeeded', 'c'.repeat(40));
    const result = state({ configured: true, latestBuild: ok, runningChange: ok });
    expect(result.name).toBe('running');
    expect(result.running).toEqual({ buildId: 'b1', commit: 'c'.repeat(40), since: T(5) });
  });

  it('prefers building to running, and keeps what runs', () => {
    const result = state({
      configured: true,
      latestBuild: build('b2', 'claimed'),
      runningChange: build('b1', 'succeeded'),
    });
    expect(result.name).toBe('building');
    expect(result.running?.buildId).toBe('b1');
  });

  it('is failed when the latest build failed and nothing runs', () => {
    const failed = build('b2', 'failed');
    expect(state({ configured: true, latestBuild: failed, runningChange: null }).name).toBe(
      'failed',
    );
  });

  it('is failed when the failed build removed the Preview that ran', () => {
    const failed = build('b2', 'failed');
    expect(state({ configured: true, latestBuild: failed, runningChange: failed }).name).toBe(
      'failed',
    );
  });

  it('is running when a build failed but an earlier one still runs', () => {
    const result = state({
      configured: true,
      latestBuild: build('b2', 'failed'),
      runningChange: build('b1', 'succeeded'),
    });
    expect(result.name).toBe('running');
    expect(result.running?.buildId).toBe('b1');
  });

  it.each(['stop', 'remove_data'] as const)('is not running after a succeeded %s', (kind) => {
    const result = state({
      configured: true,
      latestBuild: build('b1', 'succeeded'),
      runningChange: other('s1', kind),
    });
    expect(result.name).toBe('stopped');
    expect(result.running).toBeNull();
  });

  it('is not_configured below running when the settings are gone', () => {
    expect(
      state({ configured: false, latestBuild: build('b1', 'failed'), runningChange: null }).name,
    ).toBe('not_configured');
  });
});
