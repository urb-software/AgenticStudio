import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { type RunQuestion } from '../../../domain/value-objects/run-question.js';
import { type RunStepOutcome } from '../../../domain/entities/run-step-facts.js';
import { type RunStepKind } from '../../../domain/value-objects/run-step-kind.js';
import { type RunWorkingCopy } from '../../../domain/value-objects/run-working-copy.js';
import {
  StepLimitReachedError,
  RunNotFoundError,
  ReviewVerdictMissingError,
} from '../../../domain/errors/run-errors.js';
import type { RunPhaseVerdict } from '../../../domain/value-objects/run-phase.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { WORKFLOW_PLANS, type WorkflowPlans } from '../../../contracts/index.js';

export interface ReportRunStepInput {
  runId: string;
  workerId: string;
  kind: RunStepKind;
  /** The next number when absent. */
  index?: number;
  /** Already checked against the worker protocol by the entry point. */
  result: {
    outcome: 'done' | 'needs_input';
    summary: string;
    question?: RunQuestion;
    /** The agent session the step ran in; required with `needs_input`. */
    sessionRef?: string;
    pullRequest?: { title: string; body: string };
    checks?: { name: string; result: 'passed' | 'failed' | 'not_run'; detail?: string }[];
    /** A review Phase's Verdict and findings; a work Phase's are ignored. */
    verdict?: RunPhaseVerdict;
    findings?: { text: string; file?: string; line?: number }[];
  };
  workingCopy: RunWorkingCopy;
}

export interface ReportRunStepResult {
  index: number;
}

/**
 * Free text is redacted before storing, never the session reference; a re-sent step number is
 * acknowledged. Moves a Workflow Run to the next Phase its Workflow names. Throws
 * {@link RunNotFoundError}, `RunNotHeldError`, `StepLimitReachedError` or `StepOutOfOrderError`.
 */
@Injectable()
export class ReportRunStepHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(WORKFLOW_PLANS) private readonly plans: WorkflowPlans,
  ) {}

  async execute(input: ReportRunStepInput): Promise<ReportRunStepResult> {
    if (!isRunId(input.runId) || !(await this.runs.exists(input.runId))) {
      throw new RunNotFoundError();
    }
    const redaction = LogRedaction.of(await this.secrets.forRun(input.runId));
    // The session reference is an opaque id the resume needs exactly: not redacted, not in the
    // stored result.
    const { sessionRef, ...shown } = input.result;
    const redacted = redaction.runStepResult(shown);
    let outcome: RunStepOutcome | undefined;
    const saved = await this.runs.change(input.runId, (run) => {
      // Only a review Phase has a Verdict: what a work Phase's result says of one is dropped.
      const review = run.currentPhaseView.kind === 'review';
      const { verdict, findings, ...plain } = redacted;
      const result = review ? redacted : plain;
      const question = questionOf(result);
      const phaseVerdict = review && input.result.outcome === 'done' ? verdict : undefined;
      outcome = run.reportStep(
        input.workerId,
        {
          kind: input.kind,
          result,
          ...(input.index === undefined ? {} : { index: input.index }),
          ...(question ? { question } : {}),
          ...(typeof sessionRef === 'string' ? { sessionRef } : {}),
          ...(phaseVerdict === undefined
            ? {}
            : { verdict: phaseVerdict, findings: findings ?? [] }),
        },
        redaction.workingCopy(input.workingCopy),
        failingChecks(result),
        this.clock.now(),
        // Decided in the same transaction that stores the result, from the plan the Run recorded;
        // a Run started with an agent never asks, nor does a review Phase without a Verdict.
        run.workflow !== null && input.result.outcome === 'done' && (!review || phaseVerdict)
          ? this.plans.next(run.workflow.toData(), run.currentPhase, phaseVerdict ?? 'done')
          : undefined,
      );
    });
    if (!saved || !outcome) throw new RunNotFoundError();
    if (outcome.status === 'step_limit') throw new StepLimitReachedError();
    if (outcome.status === 'verdict_missing') throw new ReviewVerdictMissingError();
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
