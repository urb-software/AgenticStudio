export interface ProjectRepository {
  add(project: { name: string; createdAt: Date }): Promise<void>;
}
