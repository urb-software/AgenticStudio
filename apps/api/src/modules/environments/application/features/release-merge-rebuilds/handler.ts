import { Inject, Injectable } from '@nestjs/common';
import {
  RUN_PREVIEW_SOURCES,
  type RunPreviewSources,
} from '../../../../projects/contracts/index.js';
import type { PreviewMergeRebuild } from '../../../domain/entities/preview-merge-rebuild.js';
import { PreviewSettingsMissingError } from '../../../domain/errors/preview-operation-errors.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewLimitReachedError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../domain/errors/preview-settings-errors.js';
import {
  PREVIEW_MERGE_REBUILD_REPOSITORY,
  type PreviewMergeRebuildRepository,
} from '../../../domain/repositories/preview-merge-rebuild-repository.js';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../../../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_SETTINGS_REPOSITORY,
  type PreviewSettingsRepository,
} from '../../../domain/repositories/preview-settings-repository.js';
import {
  MergeRebuildRule,
  type MergeRebuildRuleSource,
  type MergeRebuildWaitReason,
} from '../../../domain/value-objects/merge-rebuild-rule.js';
import { PreviewState } from '../../../domain/value-objects/preview-state.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { PreviewBuildRequests } from '../../preview-build-requests.js';

export interface ReleaseMergeRebuildsResult {
  built: number;
  dropped: number;
  failed: number;
}

type Outcome = 'built' | 'dropped' | 'failed' | null;

/**
 * What a refused build request means for a recorded rebuild: nothing left to rebuild, a reason
 * that fails it at once, or a wait.
 */
type Refusal = { drop: true } | { fail: string } | { waitFor: MergeRebuildWaitReason };

/**
 * Carries out the rebuilds that merges recorded. It starts a build only for a recorded rebuild
 * and never creates one, so a merge through Studio stays the only thing that starts a build here.
 */
@Injectable()
export class ReleaseMergeRebuildsHandler {
  constructor(
    @Inject(PREVIEW_MERGE_REBUILD_REPOSITORY)
    private readonly rebuilds: PreviewMergeRebuildRepository,
    @Inject(RUN_PREVIEW_SOURCES) private readonly sources: RunPreviewSources,
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly builds: PreviewBuildRequests,
  ) {}

  async execute(): Promise<ReleaseMergeRebuildsResult> {
    const result = { built: 0, dropped: 0, failed: 0 };
    for (const rebuild of await this.rebuilds.list()) {
      const outcome = await this.release(rebuild);
      if (outcome !== null) result[outcome] += 1;
    }
    return result;
  }

  private async release(rebuild: PreviewMergeRebuild): Promise<Outcome> {
    const now = this.clock.now();
    const configured = (await this.settings.find(rebuild.projectId)) !== null;
    const facts = await this.operations.findPreviewFacts(rebuild.projectId);
    const state = PreviewState.of({ configured, ...facts });
    if (rebuild.isFailed) {
      // The operator moved on: a newer build, or a Preview that no longer runs.
      const newer = facts.latestBuild !== null && facts.latestBuild.requestedAt > rebuild.failedAt!;
      if (!newer && (state.name === 'running' || state.name === 'building')) return null;
      await this.rebuilds.delete(rebuild);
      return 'dropped';
    }
    const rule = MergeRebuildRule.create();
    const decision = rule.decide({
      state: state.name,
      runningCommit: state.running?.commit ?? null,
      source: await this.sourceOf(rebuild.projectId),
      rebuild,
      now,
    });
    switch (decision.action) {
      case 'wait':
        return null;
      case 'drop':
        await this.rebuilds.delete(rebuild);
        return 'dropped';
      case 'give_up':
        return this.fail(rebuild, decision.reason, now);
      case 'build':
        return this.build(rebuild, rule, now);
    }
  }

  private async sourceOf(projectId: string): Promise<MergeRebuildRuleSource> {
    const source = await this.sources.status(projectId);
    return source.status === 'ready'
      ? { ready: true, commit: source.commit, fetchedAt: source.fetchedAt }
      : { ready: false };
  }

  /** The build is of the Clone's Integration commit, as `prepareFromSettings` reads it. */
  private async build(
    rebuild: PreviewMergeRebuild,
    rule: MergeRebuildRule,
    now: Date,
  ): Promise<Outcome> {
    try {
      const prepared = await this.builds.prepareFromSettings(rebuild.projectId);
      await this.builds.request({ ...prepared, startedByRunId: rebuild.runId });
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal === null) throw error;
      if ('drop' in refusal) {
        await this.rebuilds.delete(rebuild);
        return 'dropped';
      }
      if ('fail' in refusal) return this.fail(rebuild, refusal.fail, now);
      const decision = rule.waiting(rebuild, now, refusal.waitFor);
      return decision.action === 'give_up' ? this.fail(rebuild, decision.reason, now) : null;
    }
    await this.rebuilds.delete(rebuild);
    return 'built';
  }

  private async fail(rebuild: PreviewMergeRebuild, reason: string, now: Date): Promise<'failed'> {
    rebuild.fail(reason, now);
    await this.rebuilds.saveFailure(rebuild);
    return 'failed';
  }
}

/** `null` for an error that is not a refusal of a build request. */
function refusalOf(error: unknown): Refusal | null {
  if (error instanceof PreviewRefusedError) {
    const reasons = error.refusals.map((entry) => entry.message).join(' ');
    return { fail: `The Compose file was refused: ${reasons}` };
  }
  if (error instanceof PreviewSourceUnavailableError) {
    return { fail: 'The Compose file could not be read from the Repository.' };
  }
  if (error instanceof PreviewSettingsMissingError || error instanceof ProjectNotFoundError) {
    return { drop: true };
  }
  if (error instanceof PreviewRepositoryNotReadyError) return { waitFor: 'clone_not_ready' };
  if (error instanceof PreviewControllerUnavailableError) return { waitFor: 'controller' };
  if (error instanceof PreviewBuildRunningError) return { waitFor: 'build_active' };
  if (error instanceof PreviewBusyError) return { waitFor: 'change_active' };
  if (error instanceof PreviewLimitReachedError) return { waitFor: 'free_place' };
  return null;
}
