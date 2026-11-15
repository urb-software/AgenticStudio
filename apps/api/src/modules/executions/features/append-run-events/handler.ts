import { cutToBytes, RUN_EVENT_TEXT_MAX_BYTES } from '@agentic-studio/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../domain/entities/run.js';
import type { RunEvent, RunEventKind } from '../../domain/entities/run-event.js';
import {
  RUN_LOG_REPOSITORY,
  type RunLogRepository,
} from '../../domain/repositories/run-log-repository.js';
import {
  RUN_REPOSITORY,
  RunNotFoundError,
  RunNotHeldError,
  type RunRepository,
} from '../../domain/repositories/run-repository.js';
import { redactLogText } from '../../domain/services/log-redaction.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from '../../ports/run-log-settings.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';

export interface AppendRunEventsInput {
  runId: string;
  workerId: string;
  /** In strictly increasing seq order (the shared contract checks it). */
  events: {
    seq: number;
    /** ISO 8601. */
    at: string;
    stepIndex: number;
    kind: RunEventKind;
    text: string;
    truncated?: boolean;
  }[];
}

/**
 * Command (Issue #99): the agent worker holding a Run appends a batch of its events. Each text
 * is redacted, then cut to the per-event cap; the store ignores seqs it already has and
 * applies the per-Run cap. Live streams of the Run are woken. Returns how many events were
 * stored. Throws {@link RunNotFoundError} or {@link RunNotHeldError}.
 */
@Injectable()
export class AppendRunEventsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG_REPOSITORY) private readonly log: RunLogRepository,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(RUN_LOG_SETTINGS) private readonly settings: RunLogSettings,
    @Inject(RUN_LOG_SIGNAL) private readonly signal: RunLogSignal,
  ) {}

  async execute(input: AppendRunEventsInput): Promise<number> {
    if (!isRunId(input.runId) || !(await this.runs.findById(input.runId))) {
      throw new RunNotFoundError();
    }
    const known = await this.secrets.forRun(input.runId);
    const events = input.events.map((event): RunEvent => {
      // Redaction first: it can lengthen a text, and the cut must not split a secret open.
      const { text, cut } = cutToBytes(redactLogText(event.text, known), RUN_EVENT_TEXT_MAX_BYTES);
      return {
        seq: event.seq,
        at: new Date(event.at),
        stepIndex: event.stepIndex,
        kind: event.kind,
        text,
        truncated: event.truncated === true || cut,
      };
    });
    const stored = await this.log.append(
      input.runId,
      input.workerId,
      events,
      this.settings.maxBytes,
    );
    if (stored === null) throw new RunNotHeldError();
    if (stored > 0) this.signal.notify(input.runId);
    return stored;
  }
}
