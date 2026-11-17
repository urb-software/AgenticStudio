import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/entities/run.js';
import type {
  RunDiffFileView,
  RunDiffScope,
  StoredRunDiff,
} from '../../../domain/entities/run-diff.js';
import {
  RUN_DIFF_REPOSITORY,
  type RunDiffRepository,
} from '../../../domain/repositories/run-diff-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';

/** The Run has no diff of that scope yet: no Run step reported a result (Issue #144). */
export class RunDiffNotFoundError extends Error {
  constructor() {
    super('run diff not found');
    this.name = 'RunDiffNotFoundError';
  }
}

/** The Run's diff lists no file at that path (Issue #144). */
export class RunDiffFileNotFoundError extends Error {
  constructor() {
    super('run diff file not found');
    this.name = 'RunDiffFileNotFoundError';
  }
}

/**
 * Queries (Issue #144): a Run's stored diff of one scope (its file list, without patches), and
 * one file of it with its patch, so a large diff loads per file. The patches were redacted when
 * they were stored. Throws {@link RunNotFoundError}, {@link RunDiffNotFoundError} or
 * {@link RunDiffFileNotFoundError}.
 */
@Injectable()
export class GetRunDiffHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_DIFF_REPOSITORY) private readonly diffs: RunDiffRepository,
  ) {}

  async diff(runId: string, scope: RunDiffScope): Promise<StoredRunDiff> {
    await this.assertRun(runId);
    const diff = await this.diffs.find(runId, scope);
    if (!diff) throw new RunDiffNotFoundError();
    return diff;
  }

  async file(runId: string, scope: RunDiffScope, path: string): Promise<RunDiffFileView> {
    await this.assertRun(runId);
    const file = await this.diffs.findFile(runId, scope, path);
    if (!file) throw new RunDiffFileNotFoundError();
    return file;
  }

  private async assertRun(runId: string): Promise<void> {
    if (!isRunId(runId) || !(await this.runs.findById(runId))) throw new RunNotFoundError();
  }
}
