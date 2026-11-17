import type { RunDiff as ReportedRunDiff } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/entities/run.js';
import {
  isEnvironmentFilePath,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH,
  type RunDiffScope,
} from '../../../domain/value-objects/run-diff.js';
import { type NewRunDiff, type RunDiffState } from '../../../domain/entities/run-diff.js';
import { RunDiff } from '../../../domain/entities/run-diff.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { RUN_TRANSACTIONS, type RunTransactions } from '../../ports/run-transactions.js';

export interface ReportRunDiffInput {
  runId: string;
  workerId: string;
  /**
   * Both diffs and where they stand (validated by the shared contract), or the reason they are
   * unavailable.
   */
  diffs:
    { run: ReportedRunDiff; last: ReportedRunDiff; state: RunDiffState } | { unavailable: string };
}

export type ReportRunDiffResult = void;

/**
 * Command (Issue #144): the agent worker holding a Run reports its diffs after a Run step's
 * result (or why they could not be computed); they replace the Run's stored diffs. Every
 * patch, and the reason, is redacted with the log's rules (security.md §3: the Run's known
 * secret values, such as its Environment file's, and token-shaped strings) before it is
 * stored. The Environment file itself is never part of a diff: the worker leaves it out, and a
 * file at its path (in any spelling) is dropped here too. The diff state is kept for the next
 * resume or delivery claim (review S-1 of #149); an unavailable report keeps the stored one.
 * That the worker holds the Run is the Run's rule, checked under the Run's lock in the same
 * transaction that replaces the diffs (`RunTransactions`). Throws {@link RunNotFoundError} or
 * {@link RunNotHeldError}.
 */
@Injectable()
export class ReportRunDiffHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_TRANSACTIONS) private readonly transactions: RunTransactions,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ReportRunDiffInput): Promise<ReportRunDiffResult> {
    const run = isRunId(input.runId) ? await this.runs.findById(input.runId) : null;
    if (!run) throw new RunNotFoundError();
    const redaction = LogRedaction.of(await this.secrets.forRun(input.runId));
    const redact = (text: string) => redaction.text(text);
    const environmentFile = run.environmentFilePath;
    const stored = (diff: ReportedRunDiff): NewRunDiff => ({
      kind: 'computed',
      baseCommit: diff.baseCommit,
      includesUnpushed: diff.includesUnpushed,
      truncated: diff.truncated,
      files: diff.files
        .filter(
          (file) =>
            !isEnvironmentFilePath(file.path, environmentFile) &&
            !(file.previousPath && isEnvironmentFilePath(file.previousPath, environmentFile)),
        )
        .map(({ patch, ...file }) => ({
          ...file,
          hasPatch: patch !== undefined,
          ...(patch === undefined ? {} : { patch: redact(patch) }),
        })),
    });
    // Redaction can lengthen the reason: cut after it, to what is stored (review L-2 of #149).
    const reason = (text: string) => redact(text).slice(0, RUN_DIFF_UNAVAILABLE_MAX_LENGTH);
    const diffs: Record<RunDiffScope, NewRunDiff> =
      'unavailable' in input.diffs
        ? {
            run: { kind: 'unavailable', reason: reason(input.diffs.unavailable) },
            last: { kind: 'unavailable', reason: reason(input.diffs.unavailable) },
          }
        : { run: stored(input.diffs.run), last: stored(input.diffs.last) };
    const state = 'state' in input.diffs ? input.diffs.state : null;
    // The diffs refuse a state that is not object ids (review S-1 of #149).
    const report = RunDiff.report({ runId: input.runId, diffs, state });
    const now = this.clock.now();
    await this.transactions.withRunLocked(input.runId, async (repositories) => {
      const locked = await repositories.runs.findById(input.runId);
      if (!locked) throw new RunNotFoundError();
      locked.assertDiffReportableBy(input.workerId);
      await repositories.diffs.replace(report, now);
    });
  }
}
