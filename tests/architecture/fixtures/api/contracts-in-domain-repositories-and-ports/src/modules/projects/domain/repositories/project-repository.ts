export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface ProjectRepository {
  add(name: string): Promise<void>;
}

export class ProjectNameTakenError extends Error {}
