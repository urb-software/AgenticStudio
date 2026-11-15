import { appendFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import {
  isSignallableGroup,
  type ProcessGroupRegistry,
  terminateProcessGroups,
} from './spawn-boundary.js';

/**
 * The process groups one Run step started (Issue #100). Each is recorded in memory and in the
 * Run's directory (one group id per line), so the worker can stop the whole tree of the step
 * when it is cancelled, over its time limit or the worker stops, and so a worker that crashed
 * can stop what is left when it starts again (`leftovers.ts`).
 */
export class StepProcesses implements ProcessGroupRegistry {
  private readonly groups = new Set<number>();

  /** @param recordFile where the group ids are kept: the Run's `step-processes` file. */
  constructor(private readonly recordFile: string) {}

  register(processGroupId: number): void {
    if (!isSignallableGroup(processGroupId) || this.groups.has(processGroupId)) return;
    this.groups.add(processGroupId);
    // Written at once, before the process can do anything worth recovering from.
    appendFileSync(this.recordFile, `${processGroupId}\n`, { mode: 0o600 });
  }

  /** The groups registered so far. */
  get registered(): readonly number[] {
    return [...this.groups];
  }

  /**
   * Stops every registered group: SIGINT, up to `graceMs` (also for `settled`, the runner's own
   * end), then SIGKILL. Returns the groups that had to be killed.
   */
  terminate(graceMs: number, settled?: Promise<unknown>): Promise<number[]> {
    return terminateProcessGroups(this.registered, { graceMs, settled });
  }

  /** Forgets the step's groups once they are gone (the record file is removed). */
  async release(): Promise<void> {
    this.groups.clear();
    await rm(this.recordFile, { force: true });
  }
}
