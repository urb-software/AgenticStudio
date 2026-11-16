import { RUN_STATES_REQUEST_MAX, type RunStatesResponse } from '@agentic-studio/contracts';
import { readdir, rm } from 'node:fs/promises';
import { posix } from 'node:path';
import {
  assertRealDirectory,
  composeProjectName,
  isUuid,
  runDirectories,
  runsDirectory,
} from './run-layout.js';
import type { RunResources } from './run-resources.js';
import { readRunFile } from './working-copy.js';

/** How often the worker applies the retention rules (besides once at start). */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Final Run states: only these Runs' Working copies fall under the retention rules. */
const FINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

export interface RetentionOptions {
  /** The worker's data directory (`<dataDir>/runs/<runId>`). */
  dataDir: string;
  /**
   * Asks Studio for the states of Runs (the worker route `runs/states`); Issue #141: reports the
   * Runs whose Working copies were removed and not yet reported (`removedRunIds`).
   */
  runStates(
    runIds: readonly string[],
    signal?: AbortSignal,
    removedRunIds?: readonly string[],
  ): Promise<RunStatesResponse>;
  /** Removes a Run's containers, networks and volumes. */
  resources: RunResources;
  /** A finished Working copy is removed after this many days... */
  retentionDays: number;
  /** ...and beyond the newest this many per Project. */
  maxPerProject: number;
  now: () => Date;
  /** The Run the worker carries right now: its directory is never touched. */
  carrying: () => string | undefined;
  logger: { info(message: string): void; error(message: string): void };
}

/** Why a Run directory was removed. */
export type RemovalReason = 'unknown_run' | 'expired' | 'over_project_limit';

export interface RetentionOutcome {
  removed: { name: string; reason: RemovalReason }[];
}

interface Finished {
  runId: string;
  finishedAt: number;
  projectId: string | null;
}

/**
 * The retention rules for Working copies (Issue #98, ADR 0002). Studio decides what a Run's
 * state is; the worker asks it for the Runs it has directories for. Then:
 * - a directory without a known Run (unknown id, or not a Run id at all) is removed;
 * - the Working copy of a Run that is not final (queued, preparing, running, waiting for the
 *   operator) is never removed, nor the one the worker is carrying; this keeps a waiting Run's
 *   Working copy and an answered one queued to resume its session (Issue #103);
 * - a final Run's Working copy is removed once it finished more than `retentionDays` ago,
 *   and beyond the newest `maxPerProject` finished ones of its Project.
 * Removing a Working copy first removes the Run's containers, networks and volumes; if that
 * fails, the directory is kept and the next pass tries again. If Studio cannot be asked,
 * no Working copy is removed (only entries that cannot be a Run directory at all).
 */
export class Retention {
  /** Removed Run Working copies Studio has not been told of yet (Issue #141). */
  private readonly unreported = new Set<string>();

  constructor(private readonly options: RetentionOptions) {}

  async sweep(signal?: AbortSignal): Promise<RetentionOutcome> {
    const outcome = await this.apply(signal);
    for (const removed of outcome.removed) {
      if (isUuid(removed.name) && removed.name === removed.name.toLowerCase()) {
        this.unreported.add(removed.name);
      }
    }
    await this.reportRemoved(signal);
    return outcome;
  }

  /**
   * Tells Studio which Working copies were removed (Issue #141), so the Run page no longer
   * offers a Follow-up. On a failure they stay pending and go with the next sweep's first
   * request; the sweep itself is not failed by it.
   */
  private async reportRemoved(signal?: AbortSignal): Promise<void> {
    while (this.unreported.size > 0) {
      const batch = [...this.unreported].slice(0, RUN_STATES_REQUEST_MAX);
      try {
        await this.options.runStates(batch, signal, batch);
      } catch (error) {
        this.options.logger.error(
          `Reporting removed Working copies failed; retried at the next sweep: ${String(error)}`,
        );
        return;
      }
      for (const runId of batch) this.unreported.delete(runId);
    }
  }

  /** The unreported removals that fit into a states request, sent with its first one. */
  private pendingBatch(): string[] {
    return [...this.unreported].slice(0, RUN_STATES_REQUEST_MAX);
  }

  private async apply(signal?: AbortSignal): Promise<RetentionOutcome> {
    const outcome: RetentionOutcome = { removed: [] };
    let runsDir: string;
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      runsDir = runsDirectory(this.options.dataDir);
      // Never through a symlink: an orphan sweep there would delete outside the data directory.
      await assertRealDirectory(runsDir, false);
      entries = await readdir(runsDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return outcome;
      throw error;
    }
    const carrying = this.options.carrying();
    const runIds: string[] = [];
    for (const entry of entries) {
      if (entry.name === carrying) continue;
      if (entry.isDirectory() && isUuid(entry.name) && entry.name === entry.name.toLowerCase()) {
        runIds.push(entry.name);
      } else {
        // Not a directory the worker makes: no Run is known for it.
        await rm(posix.join(runsDir, entry.name), { recursive: true, force: true });
        outcome.removed.push({ name: entry.name, reason: 'unknown_run' });
      }
    }
    if (runIds.length === 0) return outcome;

    const states = new Map<string, RunStatesResponse[number]>();
    for (let i = 0; i < runIds.length; i += RUN_STATES_REQUEST_MAX) {
      // The first request also carries removals an earlier sweep could not report (#141).
      const pending = i === 0 ? this.pendingBatch() : [];
      const answer = await this.options.runStates(
        runIds.slice(i, i + RUN_STATES_REQUEST_MAX),
        signal,
        ...(pending.length > 0 ? [pending] : []),
      );
      for (const runId of pending) this.unreported.delete(runId);
      for (const state of answer) states.set(state.runId, state);
    }

    const finished: Finished[] = [];
    for (const runId of runIds) {
      const state = states.get(runId);
      if (!state) {
        await this.remove(runId, 'unknown_run', outcome, signal);
      } else if (FINAL_STATES.has(state.state) && state.finishedAt !== null) {
        const runFile = await readRunFile(runDirectories(this.options.dataDir, runId).runFile);
        finished.push({
          runId,
          finishedAt: Date.parse(state.finishedAt),
          projectId: runFile?.projectId ?? null,
        });
      }
    }

    const cutoff = this.options.now().getTime() - this.options.retentionDays * DAY_MS;
    const kept: Finished[] = [];
    for (const run of finished) {
      if (run.finishedAt < cutoff) await this.remove(run.runId, 'expired', outcome, signal);
      else kept.push(run);
    }
    const byProject = new Map<string, Finished[]>();
    for (const run of kept) {
      // Without a readable run.json the Project is unknown: such a Run counts on its own, so
      // it never pushes out another Project's Working copies (the age limit still applies).
      const key = run.projectId ?? `unknown:${run.runId}`;
      byProject.set(key, [...(byProject.get(key) ?? []), run]);
    }
    for (const runs of byProject.values()) {
      runs.sort((a, b) => b.finishedAt - a.finishedAt);
      for (const run of runs.slice(this.options.maxPerProject)) {
        await this.remove(run.runId, 'over_project_limit', outcome, signal);
      }
    }
    return outcome;
  }

  /** Removes a Run's resources, then its directory; keeps the directory if the first fails. */
  private async remove(
    runId: string,
    reason: RemovalReason,
    outcome: RetentionOutcome,
    signal?: AbortSignal,
  ): Promise<void> {
    const { runDir } = runDirectories(this.options.dataDir, runId);
    try {
      await this.options.resources.cleanUp(composeProjectName(runId), signal);
    } catch (error) {
      this.options.logger.error(
        `Keeping the Working copy of run ${runId}: removing its containers failed: ${String(error)}`,
      );
      return;
    }
    await rm(runDir, { recursive: true, force: true });
    outcome.removed.push({ name: runId, reason });
    this.options.logger.info(`Removed the Working copy of run ${runId} (${reason}).`);
  }
}
