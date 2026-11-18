import { Inject, Injectable } from '@nestjs/common';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import { RunEvent } from '../../../domain/value-objects/run-event.js';
import type { RunEventKind } from '../../../domain/value-objects/run-event-kind.js';
import { RUN_LOG, type RunLog } from '../../ports/run-log.js';
import {
  RUN_REPOSITORY,
  RunNotHeldError,
  type RunRepository,
} from '../../../domain/repositories/run-repository.js';
import { LogRedaction } from '../../../domain/value-objects/log-redaction.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from '../../ports/run-log-settings.js';
import { RUN_LOG_SIGNAL, type RunLogSignal } from '../../ports/run-log-signal.js';
import { RUN_SECRET_VALUES, type RunSecretValues } from '../../ports/run-secret-values.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface AppendRunEventsInput {
  runId: string;
  workerId: string;
  events: {
    seq: number;
    at: string;
    stepIndex: number;
    kind: RunEventKind;
    text: string;
    truncated?: boolean;
  }[];
}

export interface AppendRunEventsResult {
  stored: number;
}

/** Seqs already stored are ignored. Throws {@link RunNotFoundError} or {@link RunNotHeldError}. */
@Injectable()
export class AppendRunEventsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_LOG) private readonly log: RunLog,
    @Inject(RUN_SECRET_VALUES) private readonly secrets: RunSecretValues,
    @Inject(RUN_LOG_SETTINGS) private readonly settings: RunLogSettings,
    @Inject(RUN_LOG_SIGNAL) private readonly signal: RunLogSignal,
  ) {}

  async execute(input: AppendRunEventsInput): Promise<AppendRunEventsResult> {
    if (!isRunId(input.runId) || !(await this.runs.exists(input.runId))) {
      throw new RunNotFoundError();
    }
    const redaction = LogRedaction.of(await this.secrets.forRun(input.runId));
    const events = input.events.map((event) =>
      RunEvent.load({ ...event, at: new Date(event.at) }, redaction),
    );
    const stored = await this.log.append(
      input.runId,
      input.workerId,
      events,
      this.settings.maxBytes,
    );
    if (stored === null) throw new RunNotHeldError();
    if (stored > 0) this.signal.notify(input.runId);
    return { stored };
  }
}
