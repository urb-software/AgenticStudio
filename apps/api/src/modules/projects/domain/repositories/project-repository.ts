import type { Project } from '../entities/project.js';
import type { ProjectName } from '../value-objects/project-name.js';

/** DI token for the {@link ProjectRepository} adapter. */
export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

/**
 * The Project aggregate's store. A Project's Repository connection and Environment file are
 * separate roots with their own stores (`RepositoryConnectionRepository`,
 * `EnvironmentFileRepository`): this store reads and writes the Project's table only, and a
 * handler that needs two roots asks each store (backend.md §3 rules 11 and 12).
 */
export interface ProjectRepository {
  /**
   * Persists a new project; the store assigns its id and creation time. Throws
   * {@link ProjectNameTakenError} when a project with the same `uniquenessKey` exists,
   * also when a concurrent request created it first.
   *
   * Atomic operation: the unique index on the normalized name decides a simultaneous create;
   * there is no row to lock before it exists.
   */
  add(name: ProjectName): Promise<Project>;

  /** Every project, newest first: by creation time, then by id for equal times. */
  listNewestFirst(): Promise<Project[]>;

  /** The project with this id, or `null`. */
  findById(id: string): Promise<Project | null>;
}
