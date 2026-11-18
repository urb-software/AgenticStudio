import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminateLeftovers } from '../leftovers.js';
import { readBootId, readProcessStat } from '../process-identity.js';
import { composeProjectName, runDirectories } from '../run-layout.js';
import { isSignallableGroup, terminateProcessGroups } from '../spawn-boundary.js';
import { StepProcesses } from '../step-processes.js';

// Stopping the whole process tree of a Run step, and the leftovers of a crashed worker.

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const silent = { info: () => undefined, error: () => undefined };

/**
 * Starts `script` in its own process group, as the spawn boundary starts a CLI, and resolves
 * once the script has set itself up (it prints `ready`): a signal sent earlier would reach the
 * shell before its `trap`.
 */
async function startGroup(script: string): Promise<ChildProcess> {
  const ready = script.includes('echo ready') ? script : script.replace('wait', 'echo ready; wait');
  const child = spawn('sh', ['-c', ready], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      if (chunk.includes('ready')) resolve();
    });
    child.once('error', reject);
  });
  child.stdout!.destroy();
  child.unref();
  return child;
}

function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform !== 'linux')('Run step process groups (Linux)', () => {
  let dir: string;
  const started: ChildProcess[] = [];
  const track = async (starting: Promise<ChildProcess>) => {
    const child = await starting;
    started.push(child);
    return child.pid!;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-step-processes-'));
  });

  afterEach(() => {
    // Nothing a test started outlives it, whatever it asserted.
    for (const child of started.splice(0)) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('never signals group 0 or 1 (that would reach the worker or every process)', () => {
    expect(isSignallableGroup(0)).toBe(false);
    expect(isSignallableGroup(1)).toBe(false);
    expect(isSignallableGroup(-5)).toBe(false);
    expect(isSignallableGroup(1.5)).toBe(false);
    expect(isSignallableGroup(4242)).toBe(true);
  });

  it('stops a whole tree with the interrupt when it exits within the grace', async () => {
    // A shell that exits on the interrupt, and a foreground child that gets it too (background
    // jobs of a non-interactive shell ignore SIGINT, so they would need the kill).
    const group = await track(
      startGroup("trap 'exit 0' INT; echo ready; while :; do sleep 0.1; done"),
    );

    const killed = await terminateProcessGroups([group], { graceMs: 5000 });

    expect(killed).toEqual([]);
    expect(groupAlive(group)).toBe(false);
  });

  it('kills a tree that ignores the interrupt once the grace is over (the hard path)', async () => {
    const group = await track(startGroup('trap "" INT; sleep 600 & sleep 600 & wait'));
    const started = Date.now();

    const killed = await terminateProcessGroups([group], { graceMs: 300 });

    expect(killed).toEqual([group]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(groupAlive(group)).toBe(false);
  });

  it('records each registered group with its boot and start time, and forgets them on release', async () => {
    const file = join(dir, 'step-processes');
    const processes = new StepProcesses(file);
    const group = await track(startGroup('sleep 600 & wait'));

    processes.register(group);
    processes.register(group);
    processes.register(1);

    const leader = readProcessStat(group)!;
    expect(readFileSync(file, 'utf8')).toBe(`${group} ${readBootId()} ${leader.startTime}\n`);
    await processes.terminate(1000);
    expect(groupAlive(group)).toBe(false);
    await processes.release();
    expect(existsSync(file)).toBe(false);
  });

  // A recorded group is signalled only if it is provably the step's own.
  describe('leftovers of a worker that crashed', () => {
    /** Writes the Run's record file; returns its path. */
    function recordFile(lines: string[]): string {
      const paths = runDirectories(dir, RUN_ID);
      mkdirSync(paths.runDir, { recursive: true });
      writeFileSync(paths.processesFile, lines.map((line) => `${line}\n`).join(''));
      return paths.processesFile;
    }

    const recover = (overrides: { uid?: number; cleaned?: string[] } = {}) =>
      terminateLeftovers({
        dataDir: dir,
        resources: { cleanUp: async (project) => void overrides.cleaned?.push(project) },
        logger: silent,
        graceMs: 200,
        ...(overrides.uid === undefined ? {} : { uid: overrides.uid }),
      });

    const recordLine = (
      group: number,
      boot = readBootId()!,
      start = readProcessStat(group)!.startTime,
    ) => `${group} ${boot} ${start}`;

    it("stops the step's leftover groups, removes the Run's containers, forgets the list", async () => {
      const group = await track(startGroup('trap "" INT; sleep 600 & wait'));
      // A gone leader, group 1 and garbage lines are skipped.
      const file = recordFile([recordLine(group), `999999 ${readBootId()} 1`, '1', 'not-a-pid']);
      const cleaned: string[] = [];

      const runs = await recover({ cleaned });

      expect(runs).toEqual([RUN_ID]);
      expect(groupAlive(group)).toBe(false);
      expect(cleaned).toEqual([composeProjectName(RUN_ID)]);
      expect(existsSync(file)).toBe(false);
    });

    it('skips a record from another boot', async () => {
      const group = await track(startGroup('sleep 600 & wait'));
      recordFile([recordLine(group, '00000000-0000-4000-8000-000000000000')]);

      await recover();

      expect(groupAlive(group)).toBe(true);
    });

    it('skips a reused pid: the leader started at another time', async () => {
      const group = await track(startGroup('sleep 600 & wait'));
      const start = BigInt(readProcessStat(group)!.startTime) + 1n;
      recordFile([recordLine(group, readBootId()!, String(start))]);

      await recover();

      expect(groupAlive(group)).toBe(true);
    });

    it('skips a group whose leader is gone', async () => {
      const group = await track(startGroup('sleep 600 & wait'));
      const line = recordLine(group);
      process.kill(-group, 'SIGKILL');
      await vi.waitFor(() => expect(groupAlive(group)).toBe(false));
      const cleaned: string[] = [];
      recordFile([line]);

      expect(await recover({ cleaned })).toEqual([RUN_ID]);
      // The containers are still removed; nothing is signalled.
      expect(cleaned).toEqual([composeProjectName(RUN_ID)]);
    });

    it("never signals the worker's own process group", async () => {
      const own = readProcessStat('self')!.processGroup;
      recordFile([recordLine(own)]);
      const kill = vi.spyOn(process, 'kill');
      try {
        await recover();

        expect(kill.mock.calls.filter(([pid]) => pid === -own)).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    });

    it('leaves a group alone whose processes belong to another user', async () => {
      const group = await track(startGroup('sleep 600 & wait'));
      recordFile([recordLine(group)]);

      // The same table, read as if the agent user had another id.
      await recover({ uid: (process.getuid?.() ?? 0) + 1 });

      expect(groupAlive(group)).toBe(true);
    });

    it('does nothing without a runs directory', async () => {
      expect(
        await terminateLeftovers({
          dataDir: join(dir, 'missing'),
          resources: { cleanUp: async () => undefined },
          logger: silent,
          graceMs: 200,
        }),
      ).toEqual([]);
    });
  });
});
