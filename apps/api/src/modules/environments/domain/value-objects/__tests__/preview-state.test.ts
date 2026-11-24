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

  describe('a stop or a data removal', () => {
    const change = (
      kind: 'stop' | 'remove_data',
      status: 'requested' | 'claimed' | 'succeeded' | 'failed',
    ): PreviewStateOperation => ({
      id: 'c1',
      kind,
      status,
      finishedAt: status === 'succeeded' || status === 'failed' ? T(9) : null,
      build: null,
    });
    const running = build('b1', 'succeeded');

    it.each(['requested', 'claimed'] as const)(
      'makes the state stopping while a stop is %s, and keeps what runs',
      (status) => {
        const result = state({
          configured: true,
          latestBuild: running,
          runningChange: running,
          latestChange: change('stop', status),
        });
        expect(result.name).toBe('stopping');
        expect(result.changeActive).toBe(true);
        expect(result.running?.buildId).toBe('b1');
      },
    );

    it.each(['requested', 'claimed'] as const)(
      'makes the state resetting_data while a data removal is %s',
      (status) => {
        const result = state({
          configured: true,
          latestBuild: running,
          runningChange: running,
          latestChange: change('remove_data', status),
        });
        expect(result.name).toBe('resetting_data');
      },
    );

    it('puts resetting_data before building, and stopping before building', () => {
      const rebuilding = build('b2', 'requested');
      const facts = { configured: true, latestBuild: rebuilding, runningChange: running };
      expect(state({ ...facts, latestChange: change('remove_data', 'claimed') }).name).toBe(
        'resetting_data',
      );
      expect(state({ ...facts, latestChange: change('stop', 'claimed') }).name).toBe('stopping');
      expect(state({ ...facts, latestChange: change('stop', 'succeeded') }).name).toBe('building');
    });

    it('does not let a finished change decide the state', () => {
      for (const status of ['succeeded', 'failed'] as const) {
        const result = state({
          configured: true,
          latestBuild: running,
          runningChange: running,
          latestChange: change('stop', status),
        });
        expect(result.name).toBe('running');
        expect(result.changeActive).toBe(false);
      }
    });
  });

  describe('the refusals', () => {
    const running = build('b1', 'succeeded');
    const stop = (status: 'requested' | 'succeeded'): PreviewStateOperation => ({
      id: 's1',
      kind: 'stop',
      status,
      finishedAt: status === 'succeeded' ? T(9) : null,
      build: null,
    });
    const reset: PreviewStateOperation = {
      id: 'r1',
      kind: 'remove_data',
      status: 'claimed',
      finishedAt: null,
      build: null,
    };
    const of = (facts: Partial<Parameters<typeof PreviewState.of>[0]>) =>
      state({ configured: true, latestBuild: null, runningChange: null, ...facts });
    const names = (state: PreviewState) => [
      state.buildRefusal()?.name ?? null,
      state.stopRefusal()?.name ?? null,
      state.resetRefusal()?.name ?? null,
    ];

    it('accepts everything it may: stop only when running, build and reset otherwise', () => {
      expect(names(of({ latestBuild: running, runningChange: running }))).toEqual([
        null,
        null,
        null,
      ]);
      expect(names(of({}))).toEqual([null, 'PreviewNotRunningError', null]);
      expect(names(of({ configured: false }))).toEqual([null, 'PreviewNotRunningError', null]);
      expect(names(of({ latestBuild: build('b2', 'failed') }))).toEqual([
        null,
        'PreviewNotRunningError',
        null,
      ]);
    });

    it('refuses with build_running while a build is active', () => {
      const facts = { latestBuild: build('b2', 'claimed'), runningChange: running };
      expect(names(of(facts))).toEqual([
        'PreviewBuildRunningError',
        'PreviewBuildRunningError',
        'PreviewBuildRunningError',
      ]);
    });

    it('refuses with busy while a stop or a reset is active, even with a build active', () => {
      const facts = { latestBuild: build('b2', 'requested'), runningChange: running };
      expect(names(of({ ...facts, latestChange: reset }))).toEqual([
        'PreviewBusyError',
        'PreviewBusyError',
        'PreviewBusyError',
      ]);
      expect(
        names(
          of({ latestBuild: running, runningChange: running, latestChange: stop('requested') }),
        ),
      ).toEqual(['PreviewBusyError', 'PreviewBusyError', 'PreviewBusyError']);
    });

    it('lets a finished stop leave a Preview that runs no more to be reset and built', () => {
      expect(
        names(
          of({
            latestBuild: running,
            runningChange: { ...stop('succeeded'), id: 's2' },
            latestChange: stop('succeeded'),
          }),
        ),
      ).toEqual([null, 'PreviewNotRunningError', null]);
    });
  });
});
