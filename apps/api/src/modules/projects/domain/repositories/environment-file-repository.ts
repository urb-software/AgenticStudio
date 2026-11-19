import type { EnvironmentFile } from '../entities/environment-file.js';

export const ENVIRONMENT_FILE_REPOSITORY = Symbol('ENVIRONMENT_FILE_REPOSITORY');

export interface EnvironmentFileRepository {
  /** The project's Environment file, or `null` when none is set. */
  find(projectId: string): Promise<EnvironmentFile | null>;

  /**
   * Stores the Environment file, new or replacing the project's one, with `updatedAt` set by
   * the store; returns it and the reference of the content it replaced (`null` when there was
   * none), which the caller deletes. The caller checks that the project exists.
   */
  save(
    file: EnvironmentFile,
  ): Promise<{ saved: EnvironmentFile; replacedSecretRef: string | null }>;

  /** Deletes the project's Environment file; returns its content's reference, or `null`. */
  delete(projectId: string): Promise<string | null>;

  /** The content reference of every stored Environment file (the orphan sweep keeps these). */
  listSecretRefs(): Promise<string[]>;
}
