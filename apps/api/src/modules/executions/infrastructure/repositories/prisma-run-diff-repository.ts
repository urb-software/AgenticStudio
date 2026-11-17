import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
} from '../../../../platform/database/database.module.js';
import { CLAIMED_RUN_STATES } from '../../domain/entities/run.js';
import {
  type NewRunDiff,
  RUN_DIFF_FILE_STATUSES,
  type RunDiffFileSummary,
  type RunDiffFileView,
  type RunDiffScope,
  type RunDiffState,
  type StoredRunDiff,
} from '../../domain/value-objects/run-diff.js';
import type { RunDiffRepository } from '../../domain/repositories/run-diff-repository.js';

/** The stored file list (`run_diffs.files`), checked when it is read back. */
const storedFilesSchema = z.array(
  z.object({
    path: z.string(),
    previousPath: z.string().optional(),
    status: z.enum(RUN_DIFF_FILE_STATUSES),
    additions: z.int().min(0),
    deletions: z.int().min(0),
    binary: z.literal(true).optional(),
    tooLarge: z.literal(true).optional(),
    hasPatch: z.boolean(),
  }),
);

/**
 * PostgreSQL adapter of {@link RunDiffRepository} (Issue #144): one `run_diffs` row per Run and
 * scope (the file list as JSON) and one `run_diff_files` row per file with a patch, keyed by
 * the file's position in that list; one `run_diff_states` row per Run (review S-1 of #149). A
 * report locks the Run row, checks the holder and replaces both scopes (and the state, unless
 * it is unavailable) in one transaction.
 */
@Injectable()
export class PrismaRunDiffRepository implements RunDiffRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: DatabaseClient) {}

  async replace(
    runId: string,
    workerId: string,
    diffs: Record<RunDiffScope, NewRunDiff>,
    state: RunDiffState | null,
    now: Date,
  ): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      // Held: claimed by this worker, also a failed Run held for a delivery retry (#102).
      const [run] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM runs
        WHERE id = ${runId}::uuid AND claimed_by = ${workerId}::uuid
          AND (state IN (${Prisma.join([...CLAIMED_RUN_STATES])})
               OR (state = 'failed' AND delivery_requested))
        FOR UPDATE`;
      if (!run) return false;
      // Cascades to run_diff_files.
      await tx.runDiff.deleteMany({ where: { runId } });
      for (const scope of ['run', 'last'] as const) {
        const diff = diffs[scope];
        if (diff.kind === 'unavailable') {
          await tx.runDiff.create({
            data: { runId, scope, files: [], unavailableReason: diff.reason, reportedAt: now },
          });
          continue;
        }
        const summaries: RunDiffFileSummary[] = diff.files.map(({ patch, ...file }) => {
          void patch;
          return file;
        });
        await tx.runDiff.create({
          data: {
            runId,
            scope,
            baseCommit: diff.baseCommit,
            includesUnpushed: diff.includesUnpushed,
            truncated: diff.truncated,
            files: summaries as unknown as Prisma.InputJsonValue,
            reportedAt: now,
          },
        });
        // Keyed by position in the file list: a path may be too long for an index entry.
        const patches = diff.files.flatMap((file, position) =>
          file.patch === undefined
            ? []
            : [{ runId, scope, position, path: file.path, patch: file.patch }],
        );
        if (patches.length > 0) await tx.runDiffFile.createMany({ data: patches });
      }
      if (state) {
        const columns = {
          resultTree: state.resultTree,
          resultCommit: state.resultCommit,
          previousTree: state.previousTree,
          previousCommit: state.previousCommit,
          // Issue #143 (review N2 of #141): the pushed commit is stored once, on the Run, from
          // the delivery reports; a pushed commit the worker sends with its diff state is only
          // its echo of that value.
        };
        await tx.runDiffState.upsert({
          where: { runId },
          create: { runId, ...columns },
          update: columns,
        });
      }
      return true;
    });
  }

  async find(runId: string, scope: RunDiffScope): Promise<StoredRunDiff | null> {
    const row = await this.db.runDiff.findUnique({ where: { runId_scope: { runId, scope } } });
    if (!row) return null;
    if (row.baseCommit === null) {
      return {
        kind: 'unavailable',
        reason: row.unavailableReason ?? '',
        reportedAt: row.reportedAt,
      };
    }
    return {
      kind: 'computed',
      baseCommit: row.baseCommit,
      includesUnpushed: row.includesUnpushed,
      truncated: row.truncated,
      files: storedFilesSchema.parse(row.files),
      reportedAt: row.reportedAt,
    };
  }

  async findFile(
    runId: string,
    scope: RunDiffScope,
    path: string,
  ): Promise<RunDiffFileView | null> {
    const diff = await this.find(runId, scope);
    if (!diff || diff.kind === 'unavailable') return null;
    const position = diff.files.findIndex((candidate) => candidate.path === path);
    const file = diff.files[position];
    if (!file) return null;
    if (!file.hasPatch) return file;
    const stored = await this.db.runDiffFile.findUnique({
      where: { runId_scope_position: { runId, scope, position } },
      select: { patch: true },
    });
    return stored ? { ...file, patch: stored.patch } : file;
  }

  async findState(runId: string): Promise<RunDiffState | null> {
    const row = await this.db.runDiffState.findUnique({ where: { runId } });
    if (!row) return null;
    return {
      resultTree: row.resultTree,
      resultCommit: row.resultCommit,
      previousTree: row.previousTree,
      previousCommit: row.previousCommit,
    };
  }
}
