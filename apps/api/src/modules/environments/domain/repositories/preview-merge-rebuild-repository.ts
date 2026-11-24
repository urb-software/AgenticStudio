import type { PreviewMergeRebuild } from '../entities/preview-merge-rebuild.js';

export const PREVIEW_MERGE_REBUILD_REPOSITORY = Symbol('PREVIEW_MERGE_REBUILD_REPOSITORY');

export interface PreviewMergeRebuildRepository {
  /** The Project's rebuild, or `null` when none waits. */
  find(projectId: string): Promise<PreviewMergeRebuild | null>;

  /** Every Project's rebuild, oldest recording first. */
  list(): Promise<PreviewMergeRebuild[]>;

  /** Stores the rebuild, replacing the Project's earlier one. The caller checks that the Project exists. */
  save(rebuild: PreviewMergeRebuild): Promise<void>;

  /**
   * Stores the failure of this very rebuild; `false` when a newer merge replaced it or it is
   * gone, in which case nothing changes.
   */
  saveFailure(rebuild: PreviewMergeRebuild): Promise<boolean>;

  /** Deletes this very rebuild; one that replaced it stays. */
  delete(rebuild: PreviewMergeRebuild): Promise<void>;

  /** Deletes the Project's rebuild, whichever it is; deleting none changes nothing. */
  deleteForProject(projectId: string): Promise<void>;
}
