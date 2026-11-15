import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * What identifies a process beyond its pid (review of #121), read from the Linux process table:
 * pids are reused, so a recorded process group is trusted after a restart only if it is from
 * the same boot and its leader still has the same start time.
 */

/** The process table; tests may point elsewhere. */
export const PROC_DIR = '/proc';

/** The kernel's id of the current boot, or `undefined` when it cannot be read. */
export function readBootId(procDir = PROC_DIR): string | undefined {
  try {
    const id = readFileSync(posix.join(procDir, 'sys/kernel/random/boot_id'), 'utf8').trim();
    return /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface ProcessStat {
  /** The process group (field 5 of `/proc/<pid>/stat`). */
  processGroup: number;
  /** When the process started, in clock ticks after boot (field 22). */
  startTime: string;
}

/** A process's group and start time, or `undefined` when it does not exist (any more). */
export function readProcessStat(pid: number | 'self', procDir = PROC_DIR): ProcessStat | undefined {
  try {
    const line = readFileSync(posix.join(procDir, String(pid), 'stat'), 'utf8');
    // "<pid> (<comm>) <state> <ppid> <pgrp> ..."; comm may hold spaces and parentheses, so the
    // fields are counted from after its closing parenthesis: field 3 (state) is index 0.
    const fields = line
      .slice(line.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(processGroup) || !startTime || !/^\d+$/.test(startTime)) {
      return undefined;
    }
    return { processGroup, startTime };
  } catch {
    return undefined;
  }
}

/** One recorded process group of a Run step: its id, the boot and its leader's start time. */
export interface ProcessGroupRecord {
  processGroup: number;
  bootId: string;
  startTime: string;
}

/** The record line of a process group that was just started, or `undefined` if unreadable. */
export function recordOf(processGroup: number, procDir = PROC_DIR): ProcessGroupRecord | undefined {
  const bootId = readBootId(procDir);
  const stat = readProcessStat(processGroup, procDir);
  if (!bootId || !stat) return undefined;
  return { processGroup, bootId, startTime: stat.startTime };
}

export function formatRecord(record: ProcessGroupRecord): string {
  return `${record.processGroup} ${record.bootId} ${record.startTime}`;
}

/** Parses the lines of a record file; malformed lines are left out. */
export function parseRecords(content: string): ProcessGroupRecord[] {
  const records: ProcessGroupRecord[] = [];
  for (const line of content.split('\n')) {
    const match = /^(\d{1,10}) ([0-9a-f-]{36}) (\d{1,20})$/i.exec(line.trim());
    if (match) {
      records.push({ processGroup: Number(match[1]), bootId: match[2]!, startTime: match[3]! });
    }
  }
  return records;
}
