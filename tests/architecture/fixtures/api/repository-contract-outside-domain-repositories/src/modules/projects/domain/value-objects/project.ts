export interface Project {
  id: string;
  name: string;
}

export interface ProjectRepository {
  add(project: Project): Promise<void>;
}
