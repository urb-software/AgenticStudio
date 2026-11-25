import { Inject, Injectable } from '@nestjs/common';
import { PreviewMergeRebuild } from '../../../domain/entities/preview-merge-rebuild.js';
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
import { PreviewState } from '../../../domain/value-objects/preview-state.js';
import { CLOCK, type Clock } from '../../ports/clock.js';

export interface RecordMergeRebuildInput {
  projectId: string;
  runId: string;
  mergedCommit: string;
  mergedAt: Date;
  fetchStartedAt: Date;
}

export interface RecordMergeRebuildResult {
  /** `false` when the Preview neither runs nor builds: a merge never starts it. */
  recorded: boolean;
}

/**
 * Remembers that a merge through Studio asks the Project's Preview to rebuild, replacing the
 * rebuild an earlier merge asked for. The release step starts the build once the Clone holds the merge.
 */
@Injectable()
export class RecordMergeRebuildHandler {
  constructor(
    @Inject(PREVIEW_SETTINGS_REPOSITORY) private readonly settings: PreviewSettingsRepository,
    @Inject(PREVIEW_OPERATION_REPOSITORY) private readonly operations: PreviewOperationRepository,
    @Inject(PREVIEW_MERGE_REBUILD_REPOSITORY)
    private readonly rebuilds: PreviewMergeRebuildRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(input: RecordMergeRebuildInput): Promise<RecordMergeRebuildResult> {
    const { projectId } = input;
    const configured = (await this.settings.find(projectId)) !== null;
    const state = PreviewState.of({
      configured,
      ...(await this.operations.findPreviewFacts(projectId)),
    });
    if (state.name !== 'running' && state.name !== 'building') return { recorded: false };
    await this.rebuilds.save(PreviewMergeRebuild.record({ ...input, now: this.clock.now() }));
    return { recorded: true };
  }
}
