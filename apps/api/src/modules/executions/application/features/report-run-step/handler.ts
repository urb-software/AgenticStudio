import { runStepResultSchema } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunQuestion } from '../../../domain/value-objects/run-conversation.js';
import {
  type RunStepOutcome,
  type RunStepRecord,
} from '../../../domain/entities/run-step-facts.js';
import { type RunWorkingCopy } from '../../../domain/value-objects/run-working-copy.js';
import { StepLimitReachedError, RunNotFoundError } from '../../../domain/errors/run-errors.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

export interface ReportRunStepInput extends RunStepRecord {
  runId: string;
  workerId: string;
  workingCopy: RunWorkingCopy;
}

export interface ReportRunStepResult {
  index: number;
}

/**
 * Free text is redacted before storing, never enum fields or the opaque session reference.
 * A re-sent step number is acknowledged without storing it again; the Run's `reportStep` decides under its row lock.
 * Throws {@link RunNotFoundError}, `RunNotHeldError`, {@link StepLimitReachedError} or `StepOutOfOrderError`.
 */
@Injectable()
export class ReportRunStepHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
  ) {}

  async execute(input: ReportRunStepInput): Promise<ReportRunStepResult> {
    if (!isRunId(input.runId) || !(await this.runs.exists(input.runId))) {
      throw new RunNotFoundError();
    }
    const redaction = LogRedaction.of(await this.secrets.forRun(input.runId));
    // The session reference is an opaque id the resume needs exactly: not redacted, not in the stored result.
    const { sessionRef, ...shown } = runStepResultSchema.parse(input.result);
    const result = redaction.runStepResult(shown);
    const question = questionOf(result);
    let outcome: RunStepOutcome | undefined;
    const saved = await this.runs.change(input.runId, (run) => {
      outcome = run.reportStep(
        input.workerId,
        {
          kind: input.kind,
          result,
          ...(input.index === undefined ? {} : { index: input.index }),
          ...(question ? { question } : {}),
          ...(typeof sessionRef === 'string' ? { sessionRef } : {}),
        },
        redaction.workingCopy(input.workingCopy),
        failingChecks(result),
        this.clock.now(),
      );
    });
    if (!saved || !outcome) throw new RunNotFoundError();
    if (outcome.status === 'step_limit') throw new StepLimitReachedError();
    return { index: outcome.index };
  }
}

function questionOf(result: unknown): RunQuestion | undefined {
  const { outcome, question } = (result ?? {}) as { outcome?: unknown; question?: RunQuestion };
  if (outcome !== 'needs_input' || !question) return undefined;
  return {
    text: question.text,
    ...(question.options ? { options: [...question.options] } : {}),
    ...(question.recommendation === undefined ? {} : { recommendation: question.recommendation }),
  };
}

function failingChecks(result: unknown): string[] {
  const checks = (result as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check: { result?: unknown }) => check?.result === 'failed')
    .map((check: { name?: unknown }) => String(check.name));
}
