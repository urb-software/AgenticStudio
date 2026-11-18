import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RunDiffUnavailableReason } from '../../../domain/value-objects/run-diff-unavailable-reason.js';
import { type RunDiffScope } from '../../../domain/value-objects/run-diff-scope.js';
import { type NewRunDiff } from '../../../domain/value-objects/new-run-diff.js';
import { type RunDiffFileSummary } from '../../../domain/value-objects/run-diff-file-summary.js';
import { RunDiff } from '../../../domain/entities/run-diff.js';
import { RunEnvironmentFile } from '../../../domain/value-objects/run-environment-file.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { RUN_TRANSACTIONS, type RunTransactions } from '../../ports/run-transactions.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

/** One diff as the worker reported it; the entry point has checked it against the protocol. */
export interface ReportedRunDiff {
  baseCommit: string;
  includesUnpushed: boolean;
  truncated: boolean;
  files: (Omit<RunDiffFileSummary, 'hasPatch'> & { patch?: string })[];
}

export interface ReportRunDiffInput {
  runId: string;
  workerId: string;
  diffs:
    | {
        run: ReportedRunDiff;
        last: ReportedRunDiff;
        /** Object ids only. */
        state: {
          resultTree: string;
          resultCommit: string;
          previousTree: string;
          previousCommit: string;
          pushedCommit?: string;
        };
      }
    | { unavailable: string };
}

export type ReportRunDiffResult = void;

/**
 * Patches and reasons are redacted with the log's rules; the Environment file's path is dropped in
 * any spelling. Holding the Run is checked under its lock in the transaction that replaces the
 * diffs. Throws {@link RunNotFoundError} or {@link RunNotHeldError}.
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
    const environmentFile = RunEnvironmentFile.at(run.claim.environmentFilePath);
    const stored = (diff: ReportedRunDiff): NewRunDiff => ({
      kind: 'computed',
      baseCommit: diff.baseCommit,
      includesUnpushed: diff.includesUnpushed,
      truncated: diff.truncated,
      files: diff.files
        .filter(
          (file) =>
            !environmentFile.covers(file.path) &&
            !(file.previousPath && environmentFile.covers(file.previousPath)),
        )
        .map(({ patch, ...file }) => ({
          ...file,
          hasPatch: patch !== undefined,
          ...(patch === undefined ? {} : { patch: redact(patch) }),
        })),
    });
    // Redaction can lengthen the reason: cut after it, to what is stored.
    const reason = (text: string) => RunDiffUnavailableReason.of(text, redaction).text;
    const diffs: Record<RunDiffScope, NewRunDiff> =
      'unavailable' in input.diffs
        ? {
            run: { kind: 'unavailable', reason: reason(input.diffs.unavailable) },
            last: { kind: 'unavailable', reason: reason(input.diffs.unavailable) },
          }
        : { run: stored(input.diffs.run), last: stored(input.diffs.last) };
    const state = 'state' in input.diffs ? input.diffs.state : null;
    // The diffs refuse a state that is not object ids.
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
