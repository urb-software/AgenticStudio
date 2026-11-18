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
  /** The Working copy's state after the step (Issue #98). */
  workingCopy: RunWorkingCopy;
}

export interface ReportRunStepResult {
  /** The step's number. */
  index: number;
}

/**
 * Command (Issue #96): the agent worker holding a `running` Run reports the structured result
 * of a Run step; it is stored (internal for now), and the Working copy's state it reports
 * becomes the Run's latest (Issue #98), with the checks the agent reported failed (Issue
 * #102). Its free-text fields and the commit subjects are redacted before they are stored,
 * like the log (Issue #99; never its enum fields, #104); reads redact again for rows stored
 * before. A step beyond the Run's maximum is refused and the
 * Run fails with `step_limit` (Issue #100). Returns the step's number. The Run's `reportStep`
 * decides under its row lock (Issue #169). Throws {@link RunNotFoundError}, `RunNotHeldError`
 * (not running, or not held by it), {@link StepLimitReachedError} or `StepOutOfOrderError`. A
 * retried report of a step already stored (same number) is acknowledged without storing it again
 * (review of #121).
 * Issue #103: a `needs_input` step's question becomes the Run's next message, and the session
 * reference a step reports is kept on the Run (not redacted, not in the stored result).
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
    // Issue #103: the session reference is an opaque id the resume needs exactly, so it is
    // neither redacted nor kept in the stored result; it is stored on the Run (internal).
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
        // From the redacted result: the names are shown on the Run page.
        failingChecks(result),
        this.clock.now(),
      );
    });
    if (!saved || !outcome) throw new RunNotFoundError();
    if (outcome.status === 'step_limit') throw new StepLimitReachedError();
    return { index: outcome.index };
  }
}

/** A `needs_input` result's question (validated by the contract), from the redacted result. */
function questionOf(result: unknown): RunQuestion | undefined {
  const { outcome, question } = (result ?? {}) as { outcome?: unknown; question?: RunQuestion };
  if (outcome !== 'needs_input' || !question) return undefined;
  return {
    text: question.text,
    ...(question.options ? { options: [...question.options] } : {}),
    ...(question.recommendation === undefined ? {} : { recommendation: question.recommendation }),
  };
}

/** The names of the checks a structured result reports `failed` (validated by the contract). */
function failingChecks(result: unknown): string[] {
  const checks = (result as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return [];
  return checks
    .filter((check: { result?: unknown }) => check?.result === 'failed')
    .map((check: { name?: unknown }) => String(check.name));
}
