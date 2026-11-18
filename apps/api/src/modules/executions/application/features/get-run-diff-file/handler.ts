import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type { RunDiffScope } from '../../../domain/value-objects/run-diff.js';
import type { RunDiffFileView } from '../../../domain/repositories/run-diff-repository.js';
import {
  RUN_DIFF_REPOSITORY,
  type RunDiffRepository,
} from '../../../domain/repositories/run-diff-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export class RunDiffFileNotFoundError extends Error {
  constructor() {
    super('run diff file not found');
    this.name = 'RunDiffFileNotFoundError';
  }
}

export interface GetRunDiffFileInput {
  runId: string;
  scope: RunDiffScope;
  path: string;
}

export type GetRunDiffFileResult = RunDiffFileView;

/** The patch was redacted when stored. Throws {@link RunNotFoundError} or {@link RunDiffFileNotFoundError}. */
@Injectable()
export class GetRunDiffFileHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_DIFF_REPOSITORY) private readonly diffs: RunDiffRepository,
  ) {}

  async execute(input: GetRunDiffFileInput): Promise<GetRunDiffFileResult> {
    const { runId, scope, path } = input;
    if (!isRunId(runId) || !(await this.runs.exists(runId))) throw new RunNotFoundError();
    const file = await this.diffs.findFile(runId, scope, path);
    if (!file) throw new RunDiffFileNotFoundError();
    return file;
  }
}
