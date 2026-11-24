import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import { PreviewBusyError } from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';
import { PreviewDisconnectRule } from '../../../domain/value-objects/preview-disconnect-rule.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface RemovePreviewForDisconnectInput {
  projectId: string;
}

/** `done`: nothing of the Preview is left; `pending`: the controller still removes it. */
export type RemovePreviewForDisconnectResult = 'done' | 'pending';

/**
 * The Preview's step of a Repository Disconnect, idempotent so every retry runs it again: it
 * forgets what never ran, or asks the controller to remove what did and waits for it. Without a
 * controller the request fails as `not_claimed` and the next retry asks again.
 */
@Injectable()
export class RemovePreviewForDisconnectHandler {
  constructor(
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RemovePreviewForDisconnectInput): Promise<RemovePreviewForDisconnectResult> {
    const { projectId } = input;
    const rule = PreviewDisconnectRule.create();
    const facts = await this.operations.findDisconnectFacts(projectId);
    switch (rule.next(facts)) {
      case 'forget_settings':
        await this.settings.delete(projectId);
        return 'done';
      case 'forget_everything': {
        // The rule is asked again under the claim lock: a build claimed meanwhile is kept, and
        // the next retry decides again.
        const deleted = await this.operations.deleteForDisconnect(
          projectId,
          (current) => rule.next(current) === 'forget_everything',
        );
        if (!deleted) return 'pending';
        await this.settings.delete(projectId);
        return 'done';
      }
      case 'wait_for_removal':
        return 'pending';
      case 'request_removal':
        try {
          await this.operations.add(
            PreviewOperation.requestOther({
              id: randomUUID(),
              projectId,
              kind: 'remove_data',
              now: this.clock.now(),
            }),
          );
        } catch (error) {
          // A removal that was requested meanwhile is the one to wait for.
          if (!(error instanceof PreviewBusyError)) throw error;
        }
        return 'pending';
    }
  }
}
