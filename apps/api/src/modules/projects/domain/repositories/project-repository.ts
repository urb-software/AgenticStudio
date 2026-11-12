import type { Project } from '../entities/project.js';
import type { ProjectName } from '../value-objects/project-name.js';

/** DI token for the {@link ProjectRepository} adapter. */
export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface ProjectRepository {
  /**
   * Persists a new project; the store assigns its id and creation time. Throws
   * {@link ProjectNameTakenError} when a project with the same `uniquenessKey` exists,
   * also when a concurrent request created it first.
   */
  add(name: ProjectName): Promise<Project>;

  /** Every project, newest first: by creation time, then by id for equal times. */
  listNewestFirst(): Promise<Project[]>;
}

/** Another project already has this name (compared by `ProjectName.uniquenessKey`). */
export class ProjectNameTakenError extends Error {
  constructor() {
    super('A project with this name already exists.');
    this.name = 'ProjectNameTakenError';
  }
}
