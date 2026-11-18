import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

const checkSchema = z.strictObject({
  name: z.string().min(1).max(200),
  result: z.enum(['passed', 'failed', 'not_run']),
  detail: z.string().max(4000).optional(),
});

const shownResultSchema = z.object({
  outcome: z.enum(['done', 'needs_input']),
  summary: z.string(),
  checks: z.array(checkSchema).optional(),
});

export interface RunStepView {
  index: number;
  kind: 'start' | 'resume';
  outcome: 'done' | 'needs_input';
  summary: string;
  checks: { name: string; result: 'passed' | 'failed' | 'not_run'; detail?: string }[];
  reportedAt: Date;
}

export interface ListRunStepsInput {
  runId: string;
}

export type ListRunStepsResult = RunStepView[];

/**
 * Redacted again on read, for rows stored before the redaction on store.
 * Throws {@link RunNotFoundError}.
 */
@Injectable()
export class ListRunStepsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
  ) {}

  async execute(input: ListRunStepsInput): Promise<ListRunStepsResult> {
    const { runId } = input;
    if (!isRunId(runId) || !(await this.runs.exists(runId))) throw new RunNotFoundError();
    const redaction = LogRedaction.of(await this.secrets.forRun(runId));
    const redact = (text: string) => redaction.text(text);
    const steps = await this.runs.listSteps(runId);
    return steps.map((step) => {
      // Validated by the shared contract when it was reported.
      const result = shownResultSchema.parse(step.result);
      return {
        index: step.index,
        kind: step.kind,
        outcome: result.outcome,
        summary: redact(result.summary),
        checks: (result.checks ?? []).map((check) => ({
          name: redact(check.name),
          result: check.result,
          ...(check.detail === undefined ? {} : { detail: redact(check.detail) }),
        })),
        reportedAt: step.reportedAt,
      };
    });
  }
}
