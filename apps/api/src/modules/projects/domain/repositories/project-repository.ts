import type { Project } from '../entities/project.js';
import type { ProjectKind } from '../value-objects/project-kind.js';
import type { ProjectName } from '../value-objects/project-name.js';

export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

/** The Project aggregate's store: the Project's table only. */
export interface ProjectRepository {
  /**
   * Persists a new project; the store assigns its id and creation time. Throws
   * {@link ProjectNameTakenError} for a taken name and {@link DefinitionsProjectExistsError} for
   * a second definitions Project; the unique indexes decide, also for concurrent creates.
   */
  add(name: ProjectName, kind: ProjectKind): Promise<Project>;

  /** Every project, newest first: by creation time, then by id for equal times. */
  listNewestFirst(): Promise<Project[]>;

  /** The project with this id, or `null`. */
  findById(id: string): Promise<Project | null>;

  /** The definitions Project, or `null` when none is connected. */
  findDefinitions(): Promise<Project | null>;

  /** The projects with these ids, in no order; an unknown id, or one that is not a UUID, is left out. */
  findByIds(ids: readonly string[]): Promise<Project[]>;

  /**
   * Writes the Project's merge method and no other field. `false` when the project no longer
   * exists.
   */
  saveMergeMethod(project: Project): Promise<boolean>;

  /**
   * Writes the Project's default agent and no other field. `false` when the project no longer
   * exists.
   */
  saveDefaultAgent(project: Project): Promise<boolean>;
}
