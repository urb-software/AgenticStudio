import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { posix } from 'node:path';
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
 * Recovery after a crash (Issue #100): when the worker starts, it looks for Run directories
 * that still list the process groups of a Run step (the previous worker died while carrying
 * it). It terminates each group that still has a process of the agent user, removes the Run's
 * containers through its Compose project, and forgets the list. It does not resume the Run:
 * Studio has marked it `worker_lost`, or will once its lease runs out. The Working copy is kept
 * for retention to handle. Never throws for one Run; returns the Runs it cleaned up.
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
  const cleaned: string[] = [];
  for (const runId of names.filter(isUuid)) {
    const file = runDirectories(options.dataDir, runId).processesFile;
    let listed: number[];
    try {
      listed = parseGroups(await readFile(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        options.logger.error(`Reading the process list of run ${runId} failed: ${String(error)}`);
      }
      continue;
    }
    try {
      const owned: number[] = [];
      for (const group of listed) {
        if (await hasProcessOf(group, options.uid ?? process.getuid?.() ?? -1, options.procDir)) {
          owned.push(group);
        }
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

function parseGroups(content: string): number[] {
  return [
    ...new Set(
      content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\d{1,10}$/.test(line))
        .map(Number)
        .filter(isSignallableGroup),
    ),
  ];
}

/**
 * Whether the process group still has a process that belongs to the agent user: a group id
 * from before a restart may have been reused, and the worker only ever stops its own user's
 * processes. Reads the process table: each process's group (`/proc/<pid>/stat`, the field after
 * the command name) and owner (the owner of `/proc/<pid>`).
 */
async function hasProcessOf(group: number, uid: number, procDir = '/proc'): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(procDir);
  } catch {
    return false;
  }
  for (const pid of entries.filter((name) => /^\d+$/.test(name))) {
    try {
      const statLine = await readFile(posix.join(procDir, pid, 'stat'), 'utf8');
      // "<pid> (<comm>) <state> <ppid> <pgrp> ..."; comm may hold spaces and parentheses.
      const fields = statLine.slice(statLine.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== group) continue;
      if ((await stat(posix.join(procDir, pid))).uid === uid) return true;
    } catch {
      // The process ended while the table was read.
    }
  }
  return false;
}
