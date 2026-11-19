import type { Project } from '../entities/project.js';
import type { ProjectData } from '../entities/project-data.js';

export interface ProjectRepository {
  add(project: Project): Promise<void>;
  list(): Promise<ProjectData[]>;
}
