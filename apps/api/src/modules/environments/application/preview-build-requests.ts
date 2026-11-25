import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { RUN_PREVIEW_SOURCES, type RunPreviewSources } from '../../projects/contracts/index.js';
import { PreviewOperation } from '../domain/entities/preview-operation.js';
import { PreviewSettingsMissingError } from '../domain/errors/preview-operation-errors.js';
import {
  PreviewControllerUnavailableError,
  PreviewLimitReachedError,
  PreviewRepositoryNotReadyError,
  ProjectNotFoundError,
} from '../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../domain/repositories/preview-settings-repository.js';
import { PreviewCommit } from '../domain/value-objects/preview-commit.js';
import { PreviewComposeFile } from '../domain/value-objects/preview-compose-file.js';
import { PreviewLimits } from '../domain/value-objects/preview-limits.js';
import { PreviewPort } from '../domain/value-objects/preview-port.js';
import { PreviewService } from '../domain/value-objects/preview-service.js';
import { PreviewStartLimit } from '../domain/value-objects/preview-start-limit.js';
import { PreviewState } from '../domain/value-objects/preview-state.js';
import { CLOCK, type Clock } from './ports/clock.js';
import { CONTROLLER_PRESENCE, type ControllerPresence } from './ports/controller-presence.js';
import { PREVIEW_LIMITS, type PreviewLimitsSettings } from './ports/preview-limits-settings.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from './ports/preview-operation-settings.js';
import {
  PREVIEW_RUNNING_LIMIT,
  type PreviewRunningLimitSettings,
} from './ports/preview-running-limit.js';
import { PreviewComposeJudge } from './preview-compose-judge.js';

/** What a build was made of, as far as a rebuild needs it. */
export interface PreviewBuildSnapshot {
  commit: string;
  composeFile: string;
  service: string;
  port: number;
}

/** A build ready to be requested: everything is decided but the Project's state and the limit. */
export interface PreparedPreviewBuild {
  projectId: string;
  id: string;
  now: Date;
  commit: PreviewCommit;
  composeFile: PreviewComposeFile;
  service: PreviewService;
  port: PreviewPort;
  limits: PreviewLimits;
  /** The Run whose merge through Studio asks for the build; absent for the operator's own. */
  startedByRunId?: string | undefined;
}

/**
 * The shared steps of requesting a build, for the build route, Reset and the Run merge: the
 * I/O comes first (`prepare...`), then `request` decides under the store's request lock.
 */
@Injectable()
export class PreviewBuildRequests {
  constructor(
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_LIMITS) private readonly limits: PreviewLimitsSettings,
    @Inject(PREVIEW_RUNNING_LIMIT) private readonly runningLimit: PreviewRunningLimitSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly judge: PreviewComposeJudge,
    @Inject(CONTROLLER_PRESENCE) private readonly presence: ControllerPresence,
    @Inject(PREVIEW_OPERATION_SETTINGS)
    private readonly operationSettings: PreviewOperationSettings,
  ) {}

  /** Throws `ProjectNotFoundError`. */
  async assertProject(projectId: string): Promise<void> {
    if ((await this.sources.status(projectId)).status === 'project_not_found') {
      throw new ProjectNotFoundError();
    }
  }

  /** Throws {@link PreviewControllerUnavailableError} while no controller is connected. */
  assertControllerConnected(): void {
    const availability = this.presence.availability(this.operationSettings.leaseSeconds);
    if (!availability.connected(this.clock.now())) throw new PreviewControllerUnavailableError();
  }

  /**
   * Prepares a build of the Integration branch's commit, the Compose file judged again there.
   * Throws every refusal of a build request; the state refusal here is a cheap early check, the
   * authoritative one runs in `request`.
   */
  async prepareFromSettings(projectId: string): Promise<PreparedPreviewBuild> {
    const source = await this.sources.status(projectId);
    if (source.status === 'project_not_found') throw new ProjectNotFoundError();
    const settings = await this.settings.find(projectId);
    if (settings === null) throw new PreviewSettingsMissingError();
    if (source.status !== 'ready') throw new PreviewRepositoryNotReadyError(source.status);
    this.assertControllerConnected();
    const facts = await this.operations.findPreviewFacts(projectId);
    const refusal = PreviewState.of({ configured: true, ...facts }).buildRefusal();
    if (refusal !== null) throw refusal;
    const composeFile = PreviewComposeFile.of(settings.composeFile);
    const service = PreviewService.of(settings.service);
    const port = PreviewPort.of(settings.port);
    const verdict = await this.judge.judge({ projectId, composeFile, service, port });
    return this.prepared(projectId, {
      commit: PreviewCommit.of(verdict.commit),
      composeFile,
      service,
      port,
    });
  }

  /** A rebuild of a build's own snapshot (commit, Compose file, service, port) with today's limits. */
  prepareFromBuild(projectId: string, build: PreviewBuildSnapshot): PreparedPreviewBuild {
    return this.prepared(projectId, {
      commit: PreviewCommit.of(build.commit),
      composeFile: PreviewComposeFile.of(build.composeFile),
      service: PreviewService.of(build.service),
      port: PreviewPort.of(build.port),
    });
  }

  /** The build operation; `offsetMs` makes it come after an operation requested at the same time. */
  operationOf(prepared: PreparedPreviewBuild, offsetMs = 0): PreviewOperation {
    return PreviewOperation.requestBuild({
      ...prepared,
      now: new Date(prepared.now.getTime() + offsetMs),
    });
  }

  /**
   * Requests the build under the request lock: refused while another build, a stop or a reset
   * is active and when every place of the running limit is taken. Throws
   * `PreviewBuildRunningError`, `PreviewBusyError` and `PreviewLimitReachedError`.
   */
  async request(prepared: PreparedPreviewBuild): Promise<PreviewOperation> {
    const limit = PreviewStartLimit.of(this.runningLimit.maxRunning);
    try {
      const [operation] = await this.operations.request(prepared.projectId, (facts) => {
        const refusal = PreviewState.of({ configured: true, ...facts.preview }).buildRefusal();
        if (refusal !== null) throw refusal;
        const taken = limit.refusal({ projectId: prepared.projectId, occupying: facts.occupying });
        if (taken !== null) throw new PreviewLimitReachedError(limit.max, taken);
        return [this.operationOf(prepared)];
      });
      if (operation === undefined) throw new Error('A build request stored no operation.');
      return operation;
    } catch (error) {
      if (!(error instanceof PreviewLimitReachedError)) throw error;
      // The names are read after the transaction: no I/O of another module runs under the lock.
      throw error.withNames(
        await this.sources.projectNames(error.running.map((preview) => preview.projectId)),
      );
    }
  }

  private prepared(
    projectId: string,
    chosen: Pick<PreparedPreviewBuild, 'commit' | 'composeFile' | 'service' | 'port'>,
  ): PreparedPreviewBuild {
    return {
      projectId,
      id: randomUUID(),
      now: this.clock.now(),
      limits: PreviewLimits.of(this.limits),
      ...chosen,
    };
  }
}
