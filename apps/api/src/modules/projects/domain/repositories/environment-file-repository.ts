import type { EnvironmentFileInfo, StoredEnvironmentFile } from '../entities/environment-file.js';

/** DI token for the {@link EnvironmentFileRepository} adapter. */
export const ENVIRONMENT_FILE_REPOSITORY = Symbol('ENVIRONMENT_FILE_REPOSITORY');

/**
 * The store of Projects' Environment files (Issue #104): at most one per Project, kept apart
 * from the Repository, so disconnecting the Repository leaves it in place. It holds the secret
 * store's reference to the content, never the content.
 */
export interface EnvironmentFileRepository {
  /** The project's Environment file, or `null`. */
  find(projectId: string): Promise<StoredEnvironmentFile | null>;

  /**
   * Stores the project's Environment file, new or replacing the one there, with `updatedAt`
   * set by the store; returns it and the reference of the content it replaced (`null` when
   * there was none), which the caller deletes. The caller checks that the project exists.
   */
  save(
    projectId: string,
    record: { path: string; sizeBytes: number; secretRef: string },
  ): Promise<{ saved: EnvironmentFileInfo; replacedSecretRef: string | null }>;

  /** Deletes the project's Environment file; returns its content's reference, or `null`. */
  delete(projectId: string): Promise<string | null>;

  /** The content reference of every stored Environment file (the orphan sweep keeps these). */
  listSecretRefs(): Promise<string[]>;
}
