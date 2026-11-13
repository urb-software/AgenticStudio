export interface ProjectRepository {
  add(name: string): Promise<void>;
}
