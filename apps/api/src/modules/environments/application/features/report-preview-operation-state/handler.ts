import { Inject, Injectable, Logger } from '@nestjs/common';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import { PreviewOperationNotFoundError } from '../../../domain/errors/preview-operation-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import type { PreviewFailureCode } from '../../../domain/value-objects/preview-failure-code.js';
import { PreviewLogRedaction } from '../../../domain/value-objects/preview-log-redaction.js';
import { PreviewOperationFailure } from '../../../domain/value-objects/preview-operation-failure.js';
import { PreviewOperationResult } from '../../../domain/value-objects/preview-operation-result.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  PREVIEW_SECRET_VALUES,
  type PreviewSecretValues,
} from '../../ports/preview-secret-values.js';

export interface ReportPreviewOperationStateInput {
  operationId: string;
  controllerId: string;
  state: 'in_progress' | 'succeeded' | 'failed';
  failure?: {
    code: PreviewFailureCode;
    detail: string;
    refusals?: { code: string; place: string; message: string }[];
  };
  runtime?: { services: { name: string; state: string }[] };
}

/**
 * `in_progress` is the heartbeat; a final report deletes the Environment file snapshot. Throws
 * `PreviewOperationNotFoundError`, and `PreviewOperationNotHeldError` for a final operation too.
 */
@Injectable()
export class ReportPreviewOperationStateHandler {
  private readonly logger = new Logger('ReportPreviewOperationState');

  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_SECRET_VALUES) private readonly secretValues: PreviewSecretValues,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: ReportPreviewOperationStateInput): Promise<void> {
    const { operationId, controllerId } = input;
    const now = this.clock.now();
    let released: string | undefined;
    let failure: PreviewOperationFailure | null = null;
    if (input.state === 'failed' && input.failure !== undefined) {
      // The holder first: only the holder's report decrypts the snapshot.
      const current = await this.operations.find(operationId);
      if (current === null) throw new PreviewOperationNotFoundError();
      current.assertHeldBy(controllerId);
      failure = await this.redacted(operationId, input.failure);
    }
    const changed = await this.operations.change(operationId, (held) => {
      released = held.environmentFile?.secretId;
      switch (input.state) {
        case 'in_progress':
          held.reportProgress(controllerId, now);
          released = undefined;
          return;
        case 'succeeded':
          held.succeed(
            controllerId,
            input.runtime ? PreviewOperationResult.of(input.runtime.services) : null,
            now,
          );
          return;
        case 'failed':
          held.fail(
            controllerId,
            failure ??
              PreviewOperationFailure.of('controller_error', 'The controller reported a failure.'),
            now,
          );
      }
    });
    if (changed === null) throw new PreviewOperationNotFoundError();
    if (released !== undefined) {
      await this.secrets.delete(released).catch(() => {
        // The start-up sweep removes what a failed delete leaves.
        this.logger.warn(`The Environment file snapshot ${released} could not be deleted.`);
      });
    }
  }

  private async redacted(
    operationId: string,
    failure: NonNullable<ReportPreviewOperationStateInput['failure']>,
  ): Promise<PreviewOperationFailure> {
    const redaction = PreviewLogRedaction.of(await this.secretValues.forOperation(operationId));
    return PreviewOperationFailure.of(
      failure.code,
      redaction.text(failure.detail),
      (failure.refusals ?? []).map((refusal) => ({
        ...refusal,
        place: redaction.text(refusal.place),
        message: redaction.text(refusal.message),
      })),
    );
  }
}
