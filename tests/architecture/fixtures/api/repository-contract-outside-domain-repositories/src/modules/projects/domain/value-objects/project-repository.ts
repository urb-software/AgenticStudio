import type { Project } from './project.js';

export interface ProjectRepository {
  add(project: Project): Promise<void>;
}
