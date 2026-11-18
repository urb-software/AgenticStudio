import type { EnvironmentFile } from '../entities/environment-file.js';

export const ENVIRONMENT_FILE_REPOSITORY = Symbol('ENVIRONMENT_FILE_REPOSITORY');

export interface EnvironmentFileRepository {
  find(projectId: string): Promise<EnvironmentFile | null>;

  /**
   * Stores the project's Environment file, new or replacing the one there, with `updatedAt`
   * set by the store; returns it and the reference of the content it replaced (`null` when
   * there was none), which the caller deletes. The caller checks that the project exists.
   */
  save(
    projectId: string,
    record: { path: string; sizeBytes: number; secretRef: string },
  ): Promise<{ saved: EnvironmentFile; replacedSecretRef: string | null }>;

  /** Deletes the project's Environment file; returns its content's reference, or `null`. */
  delete(projectId: string): Promise<string | null>;

  /** The content reference of every stored Environment file (the orphan sweep keeps these). */
  listSecretRefs(): Promise<string[]>;
}
