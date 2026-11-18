import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  parseRecords,
  PROC_DIR,
  type ProcessGroupRecord,
  readBootId,
  readProcessStat,
} from './process-identity.js';
import type { RunResources } from './run-resources.js';
import {
  assertRealDirectory,
  composeProjectName,
  isUuid,
  runDirectories,
  runsDirectory,
} from './run-layout.js';
import { isSignallableGroup, terminateProcessGroups } from './spawn-boundary.js';

/** Where the worker writes what it does; never a token. */
export interface LeftoversLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface LeftoversOptions {
  dataDir: string;
  /** Removes a Run's containers, networks and volumes (its Compose project). */
  resources: RunResources;
  logger: LeftoversLogger;
  /** Grace between the interrupt and the kill. */
  graceMs: number;
  /** The process table (`/proc`); tests may point elsewhere. */
  procDir?: string;
  /** The agent user's id (default: this process's). */
  uid?: number;
}

/**
 * Crash recovery at start: for each Run directory still listing process groups, terminates the
 * groups provably started by that step and removes the Run's containers; the Run is not resumed
 * (Studio fails it as `worker_lost`). Never throws for one Run; returns the Runs it cleaned up.
 */
export async function terminateLeftovers(options: LeftoversOptions): Promise<string[]> {
  const runsDir = runsDirectory(options.dataDir);
  let names: string[];
  try {
    await assertRealDirectory(runsDir, false);
    names = await readdir(runsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const procDir = options.procDir ?? PROC_DIR;
  const identity = {
    bootId: readBootId(procDir),
    ownGroup: readProcessStat('self', procDir)?.processGroup,
    uid: options.uid ?? process.getuid?.() ?? -1,
  };
  const cleaned: string[] = [];
  for (const runId of names.filter(isUuid)) {
    const file = runDirectories(options.dataDir, runId).processesFile;
    let records: ProcessGroupRecord[];
    try {
      records = parseRecords(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.logger.error(`Reading the process list of run ${runId} failed: ${String(error)}`);
      }
      continue;
    }
    try {
      const owned: number[] = [];
      for (const record of records) {
        if (await isLeftoverOfStep(record, identity, procDir)) owned.push(record.processGroup);
      }
      if (owned.length > 0) {
        await terminateProcessGroups(owned, { graceMs: options.graceMs });
        options.logger.info(
          `Stopped ${owned.length} leftover process group(s) of run ${runId} from before a restart.`,
        );
      }
      await options.resources.cleanUp(composeProjectName(runId));
      await rm(file, { force: true });
      cleaned.push(runId);
    } catch (error) {
      // The list stays, so the next start tries again.
      options.logger.error(`Cleaning up after run ${runId} failed: ${String(error)}`);
    }
  }
  return cleaned;
}

/**
 * Whether a recorded group is still the one the Run step started: same boot, the leader alive
 * with the recorded start time and still leading the group, owned by the agent user, and never
 * the worker's own group. Anything else (a reused pid, a gone leader) is left alone.
 */
async function isLeftoverOfStep(
  record: ProcessGroupRecord,
  identity: { bootId: string | undefined; ownGroup: number | undefined; uid: number },
  procDir: string,
): Promise<boolean> {
  const group = record.processGroup;
  if (!isSignallableGroup(group) || group === process.pid) return false;
  if (identity.ownGroup === undefined || group === identity.ownGroup) return false;
  if (identity.bootId === undefined || record.bootId !== identity.bootId) return false;
  const leader = readProcessStat(group, procDir);
  if (!leader || leader.startTime !== record.startTime || leader.processGroup !== group) {
    return false;
  }
  try {
    return (await stat(posix.join(procDir, String(group)))).uid === identity.uid;
  } catch {
    return false;
  }
}
