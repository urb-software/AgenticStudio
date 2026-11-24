import { Inject, Injectable, Logger } from '@nestjs/common';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { LostControllerRule } from '../../../domain/value-objects/lost-controller-rule.js';
import { OverdueBuildRule } from '../../../domain/value-objects/overdue-build-rule.js';
import { UnclaimedOperationRule } from '../../../domain/value-objects/unclaimed-operation-rule.js';
import { CONTROLLER_PRESENCE, type ControllerPresence } from '../../ports/controller-presence.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from '../../ports/preview-operation-settings.js';

export interface SweepPreviewOperationsResult {
  /** Snapshots released by the claimed operations that failed. */
  releasedSnapshots: number;
  /** Requested operations that failed as not claimed. */
  unclaimed: number;
}

/**
 * Fails the operations nobody carries: a claimed one whose controller stopped reporting, a build
 * past its time limit and margin, and, while no controller is known to exist, a requested one
 * that waited too long. The snapshot of a failed claimed operation is deleted.
 */
@Injectable()
export class SweepPreviewOperationsHandler {
  private readonly logger = new Logger('SweepPreviewOperations');

  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(PREVIEW_OPERATION_SETTINGS) private readonly settings: PreviewOperationSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONTROLLER_PRESENCE) private readonly presence: ControllerPresence,
  ) {}

  async execute(): Promise<SweepPreviewOperationsResult> {
    const now = this.clock.now();
    const lost = await this.operations.failLost(
      LostControllerRule.at(now, this.settings.leaseSeconds),
      now,
    );
    const overdue = await this.operations.failOverdue(OverdueBuildRule.at(now), now);
    for (const secretId of [...lost, ...overdue]) await this.discard(secretId);
    const unclaimed = this.presence.availability(this.settings.leaseSeconds).knownAbsent(now)
      ? await this.operations.failUnclaimed(
          UnclaimedOperationRule.at(now, this.settings.unclaimedMinutes),
          now,
        )
      : 0;
    return { releasedSnapshots: lost.length + overdue.length, unclaimed };
  }

  private async discard(secretId: string): Promise<void> {
    await this.secrets.delete(secretId).catch(() => {
      // The start-up sweep removes what a failed delete leaves.
      this.logger.warn(`The Environment file snapshot ${secretId} could not be deleted.`);
    });
  }
}
