import type { Project } from './project.js';

export class RepositoryConnection {
  private constructor(
    readonly project: Project,
    readonly state: string,
  ) {}

  static restore(project: Project, state: string): RepositoryConnection {
    return new RepositoryConnection(project, state);
  }
}
