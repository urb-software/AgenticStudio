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

// Issues #98 and #143: what the worker removes, on a real directory tree, with Studio's answers
// (which Runs are removable, which are kept until when) and the Run's containers faked (no
// Docker in unit tests). The rules themselves are Studio's and tested there. Linux only, like
// the worker.

const NOW = new Date('2026-11-15T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

type State = RunStatesResponse[number]['state'];
type Answer = Omit<RunStatesResponse[number], 'runId'>;

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
  let states: Map<string, Answer>;
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
      carrying: () => carrying,
      logger: { info: () => undefined, error: () => undefined },
      ...overrides,
    });
  }

  /**
   * A Run directory as the worker makes it, and Studio's answer for that Run: a final state is
   * `removable` or kept until a week from NOW; any other state has neither.
   */
  function run(state: State, retained?: 'removable' | 'kept'): string {
    const runId = randomUUID();
    mkdirSync(join(runsDir, runId, 'repo'), { recursive: true });
    writeFileSync(join(runsDir, runId, 'repo', 'file.txt'), 'x');
    writeFileSync(
      join(runsDir, runId, 'run.json'),
      JSON.stringify({ runId, composeProjectName: composeProjectName(runId) }),
    );
    states.set(runId, {
      state,
      finishedAt: retained === undefined ? null : new Date(NOW.getTime() - DAY).toISOString(),
      ...(retained === 'removable' ? { removable: true as const } : {}),
      ...(retained === 'kept'
        ? { keepUntil: new Date(NOW.getTime() + 7 * DAY).toISOString() }
        : {}),
    });
    return runId;
  }

  const left = () => readdirSync(runsDir).sort();

  it('removes directories without a known Run, with their containers', async () => {
    const known = run('succeeded', 'kept');
    const unknown = run('succeeded', 'kept');
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

  it('removes the Working copy of a final Run Studio calls removable, with its containers, and no other', async () => {
    const kept = run('succeeded', 'kept');
    const removable = run('failed', 'removable');
    const cancelled = run('cancelled', 'removable');
    const timedOut = run('timed_out', 'removable');

    const outcome = await retention().sweep();

    expect(left()).toEqual([kept]);
    expect(resources.cleaned.sort()).toEqual(
      [removable, cancelled, timedOut].map((id) => composeProjectName(id)).sort(),
    );
    expect(outcome.removed.map((removal) => removal.reason)).toEqual(
      Array.from({ length: 3 }, () => 'retention_ended'),
    );
  });

  it('removes the agent session files of the Working copy with it, and keeps it when that fails', async () => {
    const removable = run('succeeded', 'removable');
    const session = { provider: 'codex' as const, ref: randomUUID() };
    states.set(removable, { ...states.get(removable)!, session });
    const calls: { repoDir: string; session: unknown }[] = [];
    let failing = true;
    const sessions = {
      remove: async (repoDir: string, given?: unknown) => {
        if (failing) throw new Error('permission denied');
        calls.push({ repoDir, session: given });
      },
    };

    await retention({ sessions }).sweep();
    expect(left()).toEqual([removable]);

    failing = false;
    await retention({ sessions }).sweep();

    expect(left()).toEqual([]);
    expect(calls).toEqual([{ repoDir: join(runsDir, removable, 'repo'), session }]);
  });

  it('removes no session files of a Run that is kept', async () => {
    run('succeeded', 'kept');
    const sessions = { remove: async () => Promise.reject(new Error('must not run')) };

    await retention({ sessions }).sweep();

    expect(left()).toHaveLength(1);
  });

  it('keeps a final Run for which Studio gave no answer to remove it, however old', async () => {
    const quiet = run('succeeded');
    states.set(quiet, {
      state: 'succeeded',
      finishedAt: new Date(NOW.getTime() - 400 * DAY).toISOString(),
    });

    await retention().sweep();

    expect(left()).toEqual([quiet]);
    expect(resources.cleaned).toEqual([]);
  });

  it('never removes the Working copy of a Run that is active, waiting or queued, whatever Studio says', async () => {
    const kept = [
      run('preparing'),
      run('running'),
      run('waiting_for_operator'),
      // Also an answered Run queued to resume its session in this Working copy (Issue #103).
      run('queued'),
    ];
    for (const runId of kept) {
      states.set(runId, { ...states.get(runId)!, removable: true });
    }

    await retention().sweep();

    expect(left()).toEqual(kept.sort());
    expect(resources.cleaned).toEqual([]);
  });

  it('never touches the Run the worker is carrying, even before Studio knows it', async () => {
    const current = run('preparing');
    states.delete(current);
    carrying = current;

    await retention().sweep();

    expect(left()).toEqual([current]);
  });

  it('keeps a Working copy whose containers could not be removed, for the next pass', async () => {
    const expired = run('succeeded', 'removable');
    resources.failing = true;

    expect((await retention().sweep()).removed).toEqual([]);
    expect(left()).toEqual([expired]);

    resources.failing = false;
    await retention().sweep();
    expect(left()).toEqual([]);
  });

  it('removes no Working copy when Studio cannot be asked', async () => {
    const expired = run('succeeded', 'removable');
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
    states.set(linked, { state: 'succeeded', finishedAt: NOW.toISOString(), removable: true });

    await retention().sweep();

    expect(left()).toEqual([]);
    expect(readdirSync(target)).toEqual(['file.txt']);
  });

  it('does nothing before the first Run', async () => {
    rmSync(runsDir, { recursive: true });

    expect((await retention().sweep()).removed).toEqual([]);
  });

  describe('reporting removed Working copies (Issue #141)', () => {
    type Call = { runIds: readonly string[]; removed: readonly string[] | undefined };

    function recording(calls: Call[], failReports: { count: number }) {
      return retention({
        runStates: async (runIds, _signal, removed) => {
          calls.push({ runIds, removed });
          if (removed && failReports.count > 0) {
            failReports.count -= 1;
            throw new Error('fetch failed');
          }
          return runIds.flatMap((runId) => {
            const state = states.get(runId);
            return state ? [{ runId, ...state }] : [];
          });
        },
      });
    }

    it('tells Studio which Working copies the sweep removed', async () => {
      const kept = run('succeeded', 'kept');
      const expired = run('failed', 'removable');
      const calls: Call[] = [];

      await recording(calls, { count: 0 }).sweep();

      expect(left()).toEqual([kept]);
      expect(calls.at(-1)).toEqual({ runIds: [expired], removed: [expired] });
      expect(calls.filter((call) => call.removed !== undefined)).toHaveLength(1);
    });

    it('reports nothing when nothing was removed', async () => {
      run('succeeded', 'kept');
      const calls: Call[] = [];

      await recording(calls, { count: 0 }).sweep();

      expect(calls.every((call) => call.removed === undefined)).toBe(true);
    });

    it('keeps a removal it could not report and sends it with the next sweep', async () => {
      const kept = run('succeeded', 'kept');
      const expired = run('failed', 'removable');
      const calls: Call[] = [];
      const sweeper = recording(calls, { count: 1 });

      await sweeper.sweep();
      expect(calls.at(-1)?.removed).toEqual([expired]);

      calls.length = 0;
      await sweeper.sweep();

      expect(calls[0]).toEqual({ runIds: [kept], removed: [expired] });
      expect(calls).toHaveLength(1);
    });
  });
});
