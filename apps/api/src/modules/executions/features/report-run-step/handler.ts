import { Inject, Injectable } from '@nestjs/common';
import { isRunId, type RunWorkingCopy } from '../../domain/entities/run.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
  type RunStepRecord,
} from '../../domain/repositories/run-repository.js';
import { redactJsonStrings } from '../../domain/services/log-redaction.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

export interface ReportRunStepInput extends RunStepRecord {
  runId: string;
  workerId: string;
  /** The Working copy's state after the step (Issue #98). */
  workingCopy: RunWorkingCopy;
}

/**
 * Command (Issue #96): the agent worker holding a `running` Run reports the structured result
 * of a Run step; it is stored (internal for now), and the Working copy's state it reports
 * becomes the Run's latest (Issue #98), with the checks the agent reported failed (Issue
 * #102). Every string of the result is redacted before it is
 * stored, like the log (Issue #99); reads redact again for rows stored before. Returns the
 * step's number. Throws
 * {@link RunNotFoundError} or {@link RunNotHeldError} (not running, or not held by it).
 */
@Injectable()
export class ReportRunStepHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
  ) {}

  async execute(input: ReportRunStepInput): Promise<number> {
    if (!isRunId(input.runId) || !(await this.runs.findById(input.runId))) {
      throw new RunNotFoundError();
    }
    const known = await this.secrets.forRun(input.runId);
    const result = redactJsonStrings(input.result, known);
    const index = await this.runs.appendStep(
      input.runId,
      input.workerId,
      { kind: input.kind, result },
      input.workingCopy,
      // From the redacted result: the names are shown on the Run page.
      failingChecks(result),
    );
    if (index === null) throw new RunNotHeldError();
    return index;
  }
}

/** The names of the checks a structured result reports `failed` (validated by the contract). */
function failingChecks(result: unknown): string[] {
  const checks = (result as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check: { result?: unknown }) => check?.result === 'failed')
    .map((check: { name?: unknown }) => String(check.name));
}
