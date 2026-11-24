import { Inject, Injectable } from '@nestjs/common';
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
  PreviewAfterMergeRule,
  type PreviewAfterMergeStateName,
} from '../../../domain/value-objects/preview-after-merge-rule.js';
import { PreviewState } from '../../../domain/value-objects/preview-state.js';

export interface GetPreviewOfMergeInput {
  projectId: string;
  runId: string;
  mergedCommit: string;
  mergedAt: Date;
}

export interface GetPreviewOfMergeResult {
  state: PreviewAfterMergeStateName;
}

/** What the Project's Preview is for the commit a Run's merge made; derived, nothing is stored for it. */
@Injectable()
export class GetPreviewOfMergeHandler {
  constructor(
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_MERGE_REBUILD_REPOSITORY)
    private readonly rebuilds: PreviewMergeRebuildRepository,
  ) {}

  async execute(input: GetPreviewOfMergeInput): Promise<GetPreviewOfMergeResult> {
    const { projectId, runId, mergedCommit, mergedAt } = input;
    const configured = (await this.settings.find(projectId)) !== null;
    const state = PreviewState.of({
      configured,
      ...(await this.operations.findPreviewFacts(projectId)),
    });
    const rebuild = await this.rebuilds.find(projectId);
    const build = await this.operations.findMergeBuild(projectId, runId, mergedCommit);
    const newerBuild = build === null && (await this.operations.hasBuildSince(projectId, mergedAt));
    return {
      state: PreviewAfterMergeRule.create().state({
        runId,
        configured,
        runningBuildId: state.running?.buildId ?? null,
        rebuild: rebuild === null ? null : { runId: rebuild.runId, failed: rebuild.isFailed },
        build: build === null ? null : { id: build.id, status: build.status },
        newerBuild,
      }),
    };
  }
}
