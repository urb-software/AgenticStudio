import { appendFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { formatRecord, PROC_DIR, recordOf } from './process-identity.js';
import {
  isSignallableGroup,
  type ProcessGroupRegistry,
  terminateProcessGroups,
} from './spawn-boundary.js';

/**
 * The process groups one Run step started, kept in memory and in the Run's directory with the boot
 * id and the leader's start time (pids are reused: recovery trusts a record only from the same
 * boot and leader), so the whole tree can be stopped, also after a worker crash (`leftovers.ts`).
 */
export class StepProcesses implements ProcessGroupRegistry {
  private readonly groups = new Set<number>();

  /**
   * @param recordFile where the groups are kept: the Run's `step-processes` file.
   * @param procDir the process table (tests may point elsewhere).
   */
  constructor(
    private readonly recordFile: string,
    private readonly procDir = PROC_DIR,
  ) {}

  register(processGroupId: number): void {
    if (!isSignallableGroup(processGroupId) || this.groups.has(processGroupId)) return;
    this.groups.add(processGroupId);
    // Written at once, before the process can do anything worth recovering from. A group whose
    // identity cannot be read is still stopped with the step, but never recorded for recovery.
    const record = recordOf(processGroupId, this.procDir);
    if (record) appendFileSync(this.recordFile, `${formatRecord(record)}\n`, { mode: 0o600 });
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
