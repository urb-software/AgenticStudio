import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { terminateLeftovers } from '../leftovers.js';
import { composeProjectName, runDirectories } from '../run-layout.js';
import { isSignallableGroup, terminateProcessGroups } from '../spawn-boundary.js';
import { StepProcesses } from '../step-processes.js';

// Issue #100: stopping the whole process tree of a Run step, and the leftovers of a worker
// that crashed. Real processes (tests only start them with node:child_process); the agent
// worker is Linux-only, so this suite runs on Linux (CI) and skips elsewhere.

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

  it('records each registered group in the Run directory and forgets them on release', async () => {
    const file = join(dir, 'step-processes');
    const processes = new StepProcesses(file);
    const group = await track(startGroup('sleep 600 & wait'));

    processes.register(group);
    processes.register(group);
    processes.register(1);

    expect(readFileSync(file, 'utf8')).toBe(`${group}\n`);
    await processes.terminate(1000);
    expect(groupAlive(group)).toBe(false);
    await processes.release();
    expect(existsSync(file)).toBe(false);
  });

  describe('leftovers of a worker that crashed', () => {
    it("stops the agent user's leftover groups, removes the Run's containers, forgets the list", async () => {
      const { runDir, processesFile } = runDirectories(dir, RUN_ID);
      mkdirSync(runDir, { recursive: true });
      const group = await track(startGroup('trap "" INT; sleep 600 & wait'));
      // A gone group and garbage lines are skipped; 1 is never signalled.
      writeFileSync(processesFile, `${group}\n999999\n1\nnot-a-pid\n`);
      const cleaned: string[] = [];

      const runs = await terminateLeftovers({
        dataDir: dir,
        resources: { cleanUp: async (project) => void cleaned.push(project) },
        logger: silent,
        graceMs: 200,
      });

      expect(runs).toEqual([RUN_ID]);
      expect(groupAlive(group)).toBe(false);
      expect(cleaned).toEqual([composeProjectName(RUN_ID)]);
      expect(existsSync(processesFile)).toBe(false);
    });

    it('leaves a group alone whose processes belong to another user', async () => {
      const { runDir, processesFile } = runDirectories(dir, RUN_ID);
      mkdirSync(runDir, { recursive: true });
      const group = await track(startGroup('sleep 600 & wait'));
      writeFileSync(processesFile, `${group}\n`);

      // The same table, read as if the agent user had another id.
      await terminateLeftovers({
        dataDir: dir,
        resources: { cleanUp: async () => undefined },
        logger: silent,
        graceMs: 200,
        uid: (process.getuid?.() ?? 0) + 1,
      });

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
