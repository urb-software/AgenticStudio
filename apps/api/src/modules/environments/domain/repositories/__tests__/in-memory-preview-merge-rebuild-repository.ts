import { PreviewMergeRebuild } from '../../entities/preview-merge-rebuild.js';
import type { PreviewMergeRebuildRepository } from '../preview-merge-rebuild-repository.js';

export class InMemoryPreviewMergeRebuildRepository implements PreviewMergeRebuildRepository {
  readonly rebuilds = new Map<string, PreviewMergeRebuild>();

  find(projectId: string): Promise<PreviewMergeRebuild | null> {
    const stored = this.rebuilds.get(projectId);
    return Promise.resolve(stored ? PreviewMergeRebuild.restore(stored.toData()) : null);
  }

  list(): Promise<PreviewMergeRebuild[]> {
    return Promise.resolve(
      [...this.rebuilds.values()]
        .sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime())
        .map((stored) => PreviewMergeRebuild.restore(stored.toData())),
    );
  }

  save(rebuild: PreviewMergeRebuild): Promise<void> {
    this.rebuilds.set(rebuild.projectId, PreviewMergeRebuild.restore(rebuild.toData()));
    return Promise.resolve();
  }

  saveFailure(rebuild: PreviewMergeRebuild): Promise<boolean> {
    if (!this.isStored(rebuild)) return Promise.resolve(false);
    this.rebuilds.set(rebuild.projectId, PreviewMergeRebuild.restore(rebuild.toData()));
    return Promise.resolve(true);
  }

  delete(rebuild: PreviewMergeRebuild): Promise<void> {
    if (this.isStored(rebuild)) this.rebuilds.delete(rebuild.projectId);
    return Promise.resolve();
  }

  deleteForProject(projectId: string): Promise<void> {
    this.rebuilds.delete(projectId);
    return Promise.resolve();
  }

  private isStored(rebuild: PreviewMergeRebuild): boolean {
    const stored = this.rebuilds.get(rebuild.projectId);
    return (
      stored !== undefined &&
      stored.runId === rebuild.runId &&
      stored.recordedAt.getTime() === rebuild.recordedAt.getTime()
    );
  }
}
