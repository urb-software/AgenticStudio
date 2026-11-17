import type { ProjectId } from './project.js';

export class RepositoryConnection {
  private constructor(
    readonly projectId: ProjectId,
    readonly state: string,
  ) {}

  static restore(projectId: ProjectId, state: string): RepositoryConnection {
    return new RepositoryConnection(projectId, state);
  }
}
