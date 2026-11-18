import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type { RunDiffScope } from '../../../domain/value-objects/run-diff.js';
import type { StoredRunDiff } from '../../../domain/repositories/run-diff-repository.js';
import {
  RUN_DIFF_REPOSITORY,
  type RunDiffRepository,
} from '../../../domain/repositories/run-diff-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export class RunDiffNotFoundError extends Error {
  constructor() {
    super('run diff not found');
    this.name = 'RunDiffNotFoundError';
  }
}

export interface GetRunDiffInput {
  runId: string;
  scope: RunDiffScope;
}

export type GetRunDiffResult = StoredRunDiff;

/** The patches were redacted when stored. Throws {@link RunNotFoundError} or {@link RunDiffNotFoundError}. */
@Injectable()
export class GetRunDiffHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_DIFF_REPOSITORY) private readonly diffs: RunDiffRepository,
  ) {}

  async execute(input: GetRunDiffInput): Promise<GetRunDiffResult> {
    const { runId, scope } = input;
    if (!isRunId(runId) || !(await this.runs.exists(runId))) throw new RunNotFoundError();
    const diff = await this.diffs.find(runId, scope);
    if (!diff) throw new RunDiffNotFoundError();
    return diff;
  }
}
