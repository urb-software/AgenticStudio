import type { Project } from '../entities/project.js';
import type { ProjectName } from '../value-objects/project-name.js';

export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

/** The Project aggregate's store: the Project's table only. */
export interface ProjectRepository {
  /**
   * Persists a new project; the store assigns its id and creation time. Throws
   * {@link ProjectNameTakenError} when the `uniquenessKey` exists, also for a concurrent create
   * (the unique index decides it; there is no row to lock).
   */
  add(name: ProjectName): Promise<Project>;

  /** Every project, newest first: by creation time, then by id for equal times. */
  listNewestFirst(): Promise<Project[]>;

  /** The project with this id, or `null`. */
  findById(id: string): Promise<Project | null>;

  /**
   * Writes the Project's merge method, the one field of a Project that changes. `false` when
   * the project no longer exists.
   */
  save(project: Project): Promise<boolean>;
}
