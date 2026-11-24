import { Inject, Injectable } from '@nestjs/common';
import {
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../domain/errors/preview-operation-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PreviewLogLine,
  type PreviewLogStream,
} from '../../../domain/value-objects/preview-log-line.js';
import { PreviewLogRedaction } from '../../../domain/value-objects/preview-log-redaction.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { CONTROLLER_PRESENCE, type ControllerPresence } from '../../ports/controller-presence.js';
import {
  PREVIEW_OPERATION_LOG,
  type PreviewOperationLog,
} from '../../ports/preview-operation-log.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from '../../ports/preview-operation-settings.js';
import {
  PREVIEW_SECRET_VALUES,
  type PreviewSecretValues,
} from '../../ports/preview-secret-values.js';

export interface AppendPreviewOperationLogInput {
  operationId: string;
  controllerId: string;
  lines: {
    seq: number;
    at: Date;
    stream: PreviewLogStream;
    text: string;
    truncated?: boolean;
  }[];
}

export interface AppendPreviewOperationLogResult {
  stored: number;
  /** Whether the operation's log reached its cap: later lines are dropped. */
  truncated: boolean;
}

/**
 * Redacts each line with the operation's Environment file values and the log rules, cuts it,
 * then stores it under the cap; a line whose seq is already stored is ignored. Throws
 * {@link PreviewOperationNotFoundError} and {@link PreviewOperationNotHeldError}.
 */
@Injectable()
export class AppendPreviewOperationLogHandler {
  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_OPERATION_LOG) private readonly log: PreviewOperationLog,
    @Inject(PREVIEW_SECRET_VALUES) private readonly secretValues: PreviewSecretValues,
    @Inject(PREVIEW_OPERATION_SETTINGS) private readonly settings: PreviewOperationSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONTROLLER_PRESENCE) private readonly presence: ControllerPresence,
  ) {}

  async execute(input: AppendPreviewOperationLogInput): Promise<AppendPreviewOperationLogResult> {
    const { operationId, controllerId } = input;
    this.presence.record(this.clock.now());
    const redaction = PreviewLogRedaction.of(await this.secretValues.forOperation(operationId));
    const lines = input.lines.map((line) => PreviewLogLine.load(line, redaction));
    const appended = await this.log.append(
      operationId,
      controllerId,
      lines,
      this.settings.logMaxBytes,
    );
    if (appended !== null) return appended;
    if ((await this.operations.find(operationId)) === null) {
      throw new PreviewOperationNotFoundError();
    }
    throw new PreviewOperationNotHeldError();
  }
}
