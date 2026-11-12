export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface ProjectRepository {
  count(): Promise<number>;
  add(name: string): Promise<void>;
}
