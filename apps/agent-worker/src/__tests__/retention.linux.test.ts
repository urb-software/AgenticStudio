import type { RunStatesResponse } from '@agentic-studio/contracts';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Retention, type RetentionOptions } from '../retention.js';
import { composeProjectName } from '../run-layout.js';
import type { RunResources } from '../run-resources.js';

// Issue #98: the retention rules for Working copies, on a real directory tree, with Studio's
// answers and the Run's containers faked (no Docker in unit tests). Linux only, like the worker.

const NOW = new Date('2026-11-15T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;
const PROJECT_A = '3a5c7e9b-2d4f-4a6c-8e0b-1d3f5a7c9e2b';
const PROJECT_B = '4b6d8f0a-3e5a-4b7d-9f1c-2e4a6b8d0f3c';

type State = RunStatesResponse[number]['state'];

class RecordingResources implements RunResources {
  readonly cleaned: string[] = [];
  failing = false;
  async cleanUp(name: string) {
    if (this.failing) throw new Error('docker is not reachable');
    this.cleaned.push(name);
  }
}

describe.skipIf(process.platform !== 'linux')('Retention', () => {
  let dataDir: string;
  let runsDir: string;
  let states: Map<string, { state: State; finishedAt: string | null }>;
  let resources: RecordingResources;
  let carrying: string | undefined;
  let statesError: Error | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'studio-retention-'));
    runsDir = join(dataDir, 'runs');
    mkdirSync(runsDir);
    states = new Map();
    resources = new RecordingResources();
    carrying = undefined;
    statesError = undefined;
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  function retention(overrides: Partial<RetentionOptions> = {}) {
    return new Retention({
      dataDir,
      runStates: async (runIds) => {
        if (statesError) throw statesError;
        return runIds.flatMap((runId) => {
          const state = states.get(runId);
          return state ? [{ runId, ...state }] : [];
        });
      },
      resources,
      retentionDays: 7,
      maxPerProject: 10,
      now: () => NOW,
      carrying: () => carrying,
      logger: { info: () => undefined, error: () => undefined },
      ...overrides,
    });
  }

  /** A Run directory as the worker makes it, and Studio's state of that Run. */
  function run(projectId: string, state: State, finishedDaysAgo?: number): string {
    const runId = randomUUID();
    mkdirSync(join(runsDir, runId, 'repo'), { recursive: true });
    writeFileSync(join(runsDir, runId, 'repo', 'file.txt'), 'x');
    writeFileSync(
      join(runsDir, runId, 'run.json'),
      JSON.stringify({ runId, projectId, composeProjectName: composeProjectName(runId) }),
    );
    states.set(runId, {
      state,
      finishedAt:
        finishedDaysAgo === undefined
          ? null
          : new Date(NOW.getTime() - finishedDaysAgo * DAY).toISOString(),
    });
    return runId;
  }

  const left = () => readdirSync(runsDir).sort();

  it('removes directories without a known Run, with their containers', async () => {
    const known = run(PROJECT_A, 'succeeded', 1);
    const unknown = run(PROJECT_A, 'succeeded', 1);
    states.delete(unknown);
    mkdirSync(join(runsDir, 'not-a-run'));
    writeFileSync(join(runsDir, 'stray-file'), 'x');
    mkdirSync(join(runsDir, unknown.toUpperCase()));

    const outcome = await retention().sweep();

    expect(left()).toEqual([known]);
    expect(resources.cleaned).toEqual([composeProjectName(unknown)]);
    expect(outcome.removed.map((removal) => removal.reason)).toEqual([
      'unknown_run',
      'unknown_run',
      'unknown_run',
      'unknown_run',
    ]);
  });

  it('keeps a finished Working copy for the retention days, then removes it with its containers', async () => {
    const recent = run(PROJECT_A, 'succeeded', 6.9);
    const expired = run(PROJECT_A, 'failed', 7.1);
    const cancelled = run(PROJECT_B, 'cancelled', 30);

    await retention().sweep();

    expect(left()).toEqual([recent]);
    expect(resources.cleaned.sort()).toEqual(
      [composeProjectName(expired), composeProjectName(cancelled)].sort(),
    );
  });

  it('keeps at most the newest N finished Working copies per Project', async () => {
    const a = Array.from({ length: 12 }, (_, n) => run(PROJECT_A, 'succeeded', n * 0.1));
    const b = [run(PROJECT_B, 'succeeded', 5), run(PROJECT_B, 'timed_out', 6)];

    const outcome = await retention().sweep();

    expect(left()).toEqual([...a.slice(0, 10), ...b].sort());
    expect(outcome.removed).toEqual(
      expect.arrayContaining([
        { name: a[10], reason: 'over_project_limit' },
        { name: a[11], reason: 'over_project_limit' },
      ]),
    );
  });

  it('takes both limits from the configuration', async () => {
    const newest = run(PROJECT_A, 'succeeded', 0.5);
    run(PROJECT_A, 'succeeded', 1);
    run(PROJECT_A, 'succeeded', 2.5);

    await retention({ retentionDays: 2, maxPerProject: 1 }).sweep();

    expect(left()).toEqual([newest]);
  });

  it('never removes the Working copy of a Run that is active, waiting or queued, however old', async () => {
    const kept = [
      run(PROJECT_A, 'preparing'),
      run(PROJECT_B, 'running'),
      run(PROJECT_A, 'waiting_for_operator'),
      // Also an answered Run queued to resume its session in this Working copy (Issue #103).
      run(PROJECT_B, 'queued'),
    ];

    await retention({ retentionDays: 0, maxPerProject: 0 }).sweep();

    expect(left()).toEqual(kept.sort());
    expect(resources.cleaned).toEqual([]);
  });

  it('never touches the Run the worker is carrying, even before Studio knows it', async () => {
    const current = run(PROJECT_A, 'preparing');
    states.delete(current);
    carrying = current;

    await retention().sweep();

    expect(left()).toEqual([current]);
  });

  it('keeps a Working copy whose containers could not be removed, for the next pass', async () => {
    const expired = run(PROJECT_A, 'succeeded', 30);
    resources.failing = true;

    expect((await retention().sweep()).removed).toEqual([]);
    expect(left()).toEqual([expired]);

    resources.failing = false;
    await retention().sweep();
    expect(left()).toEqual([]);
  });

  it('removes no Working copy when Studio cannot be asked', async () => {
    const expired = run(PROJECT_A, 'succeeded', 30);
    statesError = new Error('fetch failed');

    await expect(retention().sweep()).rejects.toThrow('fetch failed');

    expect(left()).toEqual([expired]);
    expect(existsSync(join(runsDir, expired, 'repo', 'file.txt'))).toBe(true);
  });

  it('refuses to sweep a runs directory that is a symlink, deleting nothing (review of #117)', async () => {
    const elsewhere = join(dataDir, 'elsewhere');
    mkdirSync(join(elsewhere, 'precious'), { recursive: true });
    writeFileSync(join(elsewhere, 'notes.txt'), 'keep');
    rmSync(runsDir, { recursive: true });
    symlinkSync(elsewhere, runsDir);

    await expect(retention().sweep()).rejects.toThrow(/not a real directory/);

    expect(readdirSync(elsewhere).sort()).toEqual(['notes.txt', 'precious']);
  });

  it('removes a Run-named symlink itself, never what it points at', async () => {
    const target = join(dataDir, 'target');
    mkdirSync(target);
    writeFileSync(join(target, 'file.txt'), 'keep');
    const linked = randomUUID();
    symlinkSync(target, join(runsDir, linked));
    states.set(linked, { state: 'succeeded', finishedAt: NOW.toISOString() });

    await retention({ retentionDays: 0, maxPerProject: 0 }).sweep();

    expect(left()).toEqual([]);
    expect(readdirSync(target)).toEqual(['file.txt']);
  });

  it('does nothing before the first Run', async () => {
    rmSync(runsDir, { recursive: true });

    expect((await retention().sweep()).removed).toEqual([]);
  });
});
