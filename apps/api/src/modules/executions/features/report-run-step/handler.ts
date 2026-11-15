import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type RunWorkingCopy } from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
  type RunStepRecord,
} from '../../domain/repositories/run-repository.js';

export interface ReportRunStepInput extends RunStepRecord {
  runId: string;
  workerId: string;
  /** The Working copy's state after the step (Issue #98). */
  workingCopy: RunWorkingCopy;
}

/**
 * Command (Issue #96): the agent worker holding a `running` Run reports the structured result
 * of a Run step; it is stored (internal for now), and the Working copy's state it reports
 * becomes the Run's latest (Issue #98), with the checks the agent reported failed (Issue #102).
 * Returns the step's number. Throws
 * {@link RunNotFoundError} or {@link RunNotHeldError} (not running, or not held by it).
 */
/** The names of the checks a structured result reports `failed` (validated by the contract). */
function failingChecks(result: unknown): string[] {
  const checks = (result as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check: { result?: unknown }) => check?.result === 'failed')
    .map((check: { name?: unknown }) => String(check.name));
}

@Injectable()
export class ReportRunStepHandler {
  constructor(@Inject(RUN_REPOSITORY) private readonly runs: RunRepository) {}

  async execute(input: ReportRunStepInput): Promise<number> {
    if (!isRunId(input.runId) || !(await this.runs.findById(input.runId))) {
      throw new RunNotFoundError();
    }
    const index = await this.runs.appendStep(
      input.runId,
      input.workerId,
      { kind: input.kind, result: input.result },
      input.workingCopy,
      failingChecks(input.result),
    );
    if (index === null) throw new RunNotHeldError();
    return index;
  }
}
