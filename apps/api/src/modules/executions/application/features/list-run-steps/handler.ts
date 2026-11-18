import { runCheckSchema } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

/** The part of a stored structured result the operator sees at the end of a Run step. */
const shownResultSchema = z.object({
  outcome: z.enum(['done', 'needs_input']),
  summary: z.string(),
  checks: z.array(runCheckSchema).optional(),
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
 * Query (Issue #99): the structured result of each reported Run step, shown at the step's end
 * in the log: the summary and the agent's account of its checks. The agent wrote them, so
 * they get the log's redaction: on store (report-run-step) and again here, for rows stored
 * before that. Throws {@link RunNotFoundError}.
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
