import { Inject, Injectable, Logger } from '@nestjs/common';
import { SECRET_STORE, type SecretStore } from '../../../../../platform/secrets/index.js';
import {
  RUN_ENVIRONMENT_FILES,
  type RunEnvironmentFiles,
} from '../../../../projects/contracts/index.js';
import type { PreviewOperation } from '../../../domain/entities/preview-operation.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import { PreviewComposeProject } from '../../../domain/value-objects/preview-compose-project.js';
import { LostControllerRule } from '../../../domain/value-objects/lost-controller-rule.js';
import { PreviewOperationFailure } from '../../../domain/value-objects/preview-operation-failure.js';
import type { PreviewOperationKind } from '../../../domain/value-objects/preview-operation-kind.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { CONTROLLER_PRESENCE, type ControllerPresence } from '../../ports/controller-presence.js';
import { PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER } from '../../ports/preview-environment-file-snapshots.js';
import type { PreviewLimitsSettings } from '../../ports/preview-limits-settings.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from '../../ports/preview-operation-settings.js';

export interface ClaimPreviewOperationInput {
  controllerId: string;
}

/** What the controller needs to carry out a claimed operation. */
export interface ClaimedPreviewOperation {
  id: string;
  projectId: string;
  kind: PreviewOperationKind;
  /** The Compose project name of the Project's Preview. */
  composeProject: string;
  /** The hostname label of the Project's Preview, the controller's socket name. */
  previewLabel: string;
  /** Set exactly for a build. */
  build: {
    commit: string;
    composeFile: string;
    service: string;
    port: number;
    limits: PreviewLimitsSettings;
  } | null;
  /** Test values only; goes to the claiming controller, never logged. */
  environmentFile: { path: string; content: string } | null;
}

export type ClaimPreviewOperationResult = ClaimedPreviewOperation | null;

const ENVIRONMENT_FILE_UNAVAILABLE = PreviewOperationFailure.of(
  'controller_error',
  "Studio could not read the Project's Environment file for this build. Request the build again; " +
    'if it keeps failing, set the Environment file again.',
);

/**
 * `null` when nothing is to do. Operations of a controller that stopped reporting fail first and
 * are never handed out again. A build whose Environment file snapshot fails is failed, not started.
 */
@Injectable()
export class ClaimPreviewOperationHandler {
  private readonly logger = new Logger('ClaimPreviewOperation');

  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(RUN_ENVIRONMENT_FILES) private readonly environmentFiles: RunEnvironmentFiles,
    @Inject(SECRET_STORE) private readonly secrets: SecretStore,
    @Inject(PREVIEW_OPERATION_SETTINGS) private readonly settings: PreviewOperationSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(CONTROLLER_PRESENCE) private readonly presence: ControllerPresence,
  ) {}

  async execute(input: ClaimPreviewOperationInput): Promise<ClaimPreviewOperationResult> {
    const { controllerId } = input;
    const now = this.clock.now();
    this.presence.record(now);
    const lost = LostControllerRule.at(now, this.settings.leaseSeconds);
    for (const secretId of await this.operations.failLost(lost, now)) {
      await this.discard(secretId);
    }
    for (;;) {
      const operation = await this.operations.claimNext(controllerId, now);
      if (operation === null) return null;
      if (operation.build === null) return claimed(operation, null);
      const environmentFile = await this.snapshot(operation, controllerId, now);
      if (environmentFile === FAILED) continue;
      return claimed(operation, environmentFile);
    }
  }

  /** `null` when the Project has no file. */
  private async snapshot(
    operation: PreviewOperation,
    controllerId: string,
    now: Date,
  ): Promise<{ path: string; content: string } | null | typeof FAILED> {
    let secretId: string | undefined;
    try {
      const file = await this.environmentFiles.forProject(operation.projectId);
      if (file === null) return null;
      secretId = await this.secrets.put(file.content, {
        owner: PREVIEW_ENVIRONMENT_FILE_SECRET_OWNER,
      });
      const kept = secretId;
      const recorded = await this.operations.change(operation.id, (held) => {
        held.recordEnvironmentFile(controllerId, { path: file.path, secretId: kept });
      });
      if (recorded === null) throw new Error('The operation is gone.');
      return file;
    } catch (error) {
      // Only the error's class name: nothing logged here can hold the content.
      this.logger.error(
        `The Environment file of operation ${operation.id} could not be prepared: ${errorName(error)}`,
      );
    }
    if (secretId !== undefined) await this.discard(secretId);
    await this.operations
      .change(operation.id, (held) => {
        held.fail(controllerId, ENVIRONMENT_FILE_UNAVAILABLE, now);
      })
      .catch(() => null);
    return FAILED;
  }

  private async discard(secretId: string): Promise<void> {
    await this.secrets.delete(secretId).catch(() => {
      // The start-up sweep removes what a failed delete leaves.
      this.logger.warn(`The Environment file snapshot ${secretId} could not be deleted.`);
    });
  }
}

const FAILED = Symbol('FAILED');

function claimed(
  operation: PreviewOperation,
  environmentFile: { path: string; content: string } | null,
): ClaimedPreviewOperation {
  return {
    id: operation.id,
    projectId: operation.projectId,
    kind: operation.kind,
    composeProject: PreviewComposeProject.of(operation.projectId).value,
    previewLabel: PreviewComposeProject.of(operation.projectId).label,
    build:
      operation.build === null
        ? null
        : {
            commit: operation.build.commit,
            composeFile: operation.build.composeFile,
            service: operation.build.service,
            port: operation.build.port,
            limits: { ...operation.build.limits },
          },
    environmentFile,
  };
}

function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : 'Error';
}
