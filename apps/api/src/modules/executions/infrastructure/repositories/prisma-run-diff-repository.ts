import { Prisma } from '@agentic-studio/database';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE_CLIENT } from '../../../../platform/database/database.module.js';
import type { RunDiff } from '../../domain/entities/run-diff.js';
import { RUN_DIFF_FILE_STATUSES } from '../../domain/value-objects/run-diff-file-status.js';
import { type RunDiffScope } from '../../domain/value-objects/run-diff-scope.js';
import { type RunDiffFileSummary } from '../../domain/value-objects/run-diff-file-summary.js';
import { type RunDiffStateInput } from '../../domain/value-objects/run-diff-state.js';
import {
  type RunDiffFileView,
  type StoredRunDiff,
} from '../../domain/repositories/run-diff-repository.js';
import type { RunDiffRepository } from '../../domain/repositories/run-diff-repository.js';
import { type Executor, inTransaction } from './executor.js';

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
 * That the reporting worker holds the Run is checked under the Run's lock by the calling
 * transaction; a report replaces both scopes (and the state, unless
 * unavailable) in that transaction.
 */
@Injectable()
export class PrismaRunDiffRepository implements RunDiffRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly db: Executor) {}

  async replace(report: RunDiff, now: Date): Promise<void> {
    const { runId, diffs, state } = report;
    await inTransaction(this.db, async (tx) => {
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
          // The pushed commit is stored once, on the Run, from the delivery reports; the one a
          // worker sends with its diff state is only its echo of that value.
        };
        await tx.runDiffState.upsert({
          where: { runId },
          create: { runId, ...columns },
          update: columns,
        });
      }
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

  async findState(runId: string): Promise<RunDiffStateInput | null> {
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
