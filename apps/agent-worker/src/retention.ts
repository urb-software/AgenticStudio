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
import type { AgentSession, AgentSessionFiles } from './agent-sessions.js';
import type { RunResources } from './run-resources.js';

/** How often the worker applies the retention rules (besides once at start). */
export const RETENTION_INTERVAL_MS = 60 * 60_000;

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
  /**
   * Removes the session files the provider CLIs keep for a Run's Working copy (Issue #143),
   * after its containers and before its directory; without it none are removed.
   */
  sessions?: AgentSessionFiles;
  /** The Run the worker carries right now: its directory is never touched. */
  carrying: () => string | undefined;
  logger: { info(message: string): void; error(message: string): void };
}

/**
 * Why a Run directory was removed: no Run is known for it, or Studio said the Run's Working copy
 * is no longer kept (Issue #143; Studio's reasons are its own business).
 */
export type RemovalReason = 'unknown_run' | 'retention_ended';

export interface RetentionOutcome {
  removed: { name: string; reason: RemovalReason }[];
}

/**
 * The retention of Working copies (Issue #98, ADR 0002; Issue #143). Studio decides: it knows each
 * Run's pull request, its last activity and its Project's other Runs, and answers, for each Run
 * directory the worker asks about, whether the Working copy is kept (`keepUntil`) or `removable`.
 * The worker removes:
 * - a directory without a known Run (unknown id, or not a Run id at all);
 * - the Working copy of a final Run that Studio says is `removable`.
 * The Working copy of a Run that is not final (queued, preparing, running, waiting for the
 * operator) is never removed, nor the one the worker is carrying; a final Run without an answer
 * to remove is kept. Removing a Working copy first removes the Run's containers, networks and
 * volumes, then the agent session files of its Working copy (Issue #143; a failure there is logged and
 * does not keep the Working copy); if the containers cannot be removed, the directory is kept
 * and the next pass tries again. If Studio cannot
 * be asked, no Working copy is removed (only entries that cannot be a Run directory at all).
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

    for (const runId of runIds) {
      const state = states.get(runId);
      if (!state) {
        await this.remove(runId, 'unknown_run', outcome, signal);
      } else if (FINAL_STATES.has(state.state) && state.removable === true) {
        await this.remove(runId, 'retention_ended', outcome, signal, state.session);
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
    session?: AgentSession,
  ): Promise<void> {
    const { runDir, repoDir } = runDirectories(this.options.dataDir, runId);
    try {
      await this.options.resources.cleanUp(composeProjectName(runId), signal);
    } catch (error) {
      this.options.logger.error(
        `Keeping the Working copy of run ${runId}: removing its containers failed: ${String(error)}`,
      );
      return;
    }
    try {
      // Only for a directory named like a Run (its path is then derived from the id).
      if (isUuid(runId)) await this.options.sessions?.remove(repoDir, session);
    } catch (error) {
      // Session files are secondary: never block the removal of the Working copy.
      this.options.logger.error(
        `Removing the agent session files of run ${runId} failed; its Working copy is removed anyway: ${String(error)}`,
      );
    }
    await rm(runDir, { recursive: true, force: true });
    outcome.removed.push({ name: runId, reason });
    this.options.logger.info(`Removed the Working copy of run ${runId} (${reason}).`);
  }
}
