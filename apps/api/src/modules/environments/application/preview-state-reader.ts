import { Inject, Injectable } from '@nestjs/common';
import {
  PREVIEW_OPERATION_REPOSITORY,
  type PreviewOperationRepository,
} from '../domain/repositories/preview-operation-repository.js';
import {
  PREVIEW_MERGE_REBUILD_REPOSITORY,
  type PreviewMergeRebuildRepository,
} from '../domain/repositories/preview-merge-rebuild-repository.js';
import {
  MergeRebuildRule,
  type MergeRebuildRuleSource,
} from '../domain/value-objects/merge-rebuild-rule.js';
import { PreviewHostname } from '../domain/value-objects/preview-hostname.js';
import { PreviewState } from '../domain/value-objects/preview-state.js';
import { CLOCK, type Clock } from './ports/clock.js';
import { CONTROLLER_PRESENCE, type ControllerPresence } from './ports/controller-presence.js';
import {
  PREVIEW_OPERATION_SETTINGS,
  type PreviewOperationSettings,
} from './ports/preview-operation-settings.js';
import {
  previewBuildView,
  previewChangeView,
  previewMergeRebuildView,
  type PreviewStateView,
} from './preview-view.js';

/** Derives a Project's Preview state from its operations and the controller's presence. */
@Injectable()
export class PreviewStateReader {
  constructor(
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(CONTROLLER_PRESENCE) private readonly presence: ControllerPresence,
    @Inject(PREVIEW_OPERATION_SETTINGS) private readonly settings: PreviewOperationSettings,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PREVIEW_MERGE_REBUILD_REPOSITORY)
    private readonly rebuilds: PreviewMergeRebuildRepository,
  ) {}

  /** `domain` is the preview domain, or `null` while none is configured. */
  async read(input: {
    projectId: string;
    configured: boolean;
    domain: string | null;
    source: MergeRebuildRuleSource;
  }): Promise<PreviewStateView> {
    const { projectId, configured, domain, source } = input;
    const { latestBuild, runningChange, latestChange } =
      await this.operations.findPreviewFacts(projectId);
    const state = PreviewState.of({ configured, latestBuild, runningChange, latestChange });
    const availability = this.presence.availability(this.settings.leaseSeconds);
    const now = this.clock.now();
    const shown = state.running?.commit ?? latestBuild?.build?.commit ?? null;
    const rebuild = await this.rebuilds.find(projectId);
    return {
      state: state.name,
      running:
        state.running === null
          ? null
          : {
              ...state.running,
              url:
                domain === null ? null : `https://${PreviewHostname.of(projectId, domain).value}/`,
            },
      latestBuild: latestBuild === null ? null : previewBuildView(latestBuild),
      latestChange: latestChange === null ? null : previewChangeView(latestChange),
      controller: { connected: availability.connected(this.clock.now()) },
      buildActive: state.buildActive,
      behind: source.ready && shown !== null && shown !== source.commit,
      mergeRebuild:
        rebuild === null
          ? null
          : previewMergeRebuildView(
              rebuild,
              MergeRebuildRule.create().decide({
                state: state.name,
                runningCommit: state.running?.commit ?? null,
                source,
                rebuild,
                now,
              }),
            ),
    };
  }
}
