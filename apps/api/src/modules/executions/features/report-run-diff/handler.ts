import type { RunDiff } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../domain/entities/run.js';
import {
  isEnvironmentFilePath,
  isRunDiffState,
  type NewRunDiff,
  RUN_DIFF_UNAVAILABLE_MAX_LENGTH,
  type RunDiffScope,
  type RunDiffState,
} from '../../domain/entities/run-diff.js';
import {
  RUN_DIFF_REPOSITORY,
  type RunDiffRepository,
} from '../../domain/repositories/run-diff-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { redactLogText } from '../../domain/services/log-redaction.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

export interface ReportRunDiffInput {
  runId: string;
  workerId: string;
  /**
   * Both diffs and where they stand (validated by the shared contract), or the reason they are
   * unavailable.
   */
  diffs: { run: RunDiff; last: RunDiff; state: RunDiffState } | { unavailable: string };
}

/**
 * Command (Issue #144): the agent worker holding a Run reports its diffs after a Run step's
 * result (or why they could not be computed); they replace the Run's stored diffs. Every
 * patch, and the reason, is redacted with the log's rules (security.md §3: the Run's known
 * secret values, such as its Environment file's, and token-shaped strings) before it is
 * stored. The Environment file itself is never part of a diff: the worker leaves it out, and a
 * file at its path (in any spelling) is dropped here too. The diff state is kept for the next
 * resume or delivery claim (review S-1 of #149); an unavailable report keeps the stored one.
 * Throws {@link RunNotFoundError} or {@link RunNotHeldError}.
 */
@Injectable()
export class ReportRunDiffHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_DIFF_REPOSITORY) private readonly diffs: RunDiffRepository,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ReportRunDiffInput): Promise<void> {
    const run = isRunId(input.runId) ? await this.runs.findById(input.runId) : null;
    if (!run) throw new RunNotFoundError();
    const known = await this.secrets.forRun(input.runId);
    const redact = (text: string) => redactLogText(text, known);
    const environmentFile = run.environmentFilePath;
    const stored = (diff: RunDiff): NewRunDiff => ({
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
    // The contract checked the format; checked again before it is kept (review S-1 of #149).
    if (state && !isRunDiffState(state)) throw new Error('The diff state is not object ids.');
    const now = this.clock.now();
    if (!(await this.diffs.replace(input.runId, input.workerId, diffs, state, now))) {
      throw new RunNotHeldError();
    }
  }
}
