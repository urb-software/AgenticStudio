import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import { PreviewOperation } from '../../../domain/entities/preview-operation.js';
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
  /** State checks requested for Projects whose lost build left the Preview unknown. */
  stateChecks: number;
}

/**
 * Fails the operations nobody carries and deletes the snapshots they held, then, while a
 * controller is connected, asks it what runs for every Project whose newest operation is a build it lost.
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
    return {
      releasedSnapshots: lost.length + overdue.length,
      unclaimed,
      stateChecks: await this.requestStateChecks(now),
    };
  }

  /**
   * Waits for a controller: a check nobody claims fails as `not_claimed`, becomes the newest
   * operation and ends the selection for good.
   */
  private async requestStateChecks(now: Date): Promise<number> {
    if (!this.presence.availability(this.settings.leaseSeconds).connected(now)) return 0;
    const projectIds = await this.operations.findStateCheckProjects();
    for (const projectId of projectIds) {
      await this.operations.add(
        PreviewOperation.requestOther({ id: randomUUID(), projectId, kind: 'state', now }),
      );
    }
    return projectIds.length;
  }

  private async discard(secretId: string): Promise<void> {
    await this.secrets.delete(secretId).catch(() => {
      // The start-up sweep removes what a failed delete leaves.
      this.logger.warn(`The Environment file snapshot ${secretId} could not be deleted.`);
    });
  }
}
