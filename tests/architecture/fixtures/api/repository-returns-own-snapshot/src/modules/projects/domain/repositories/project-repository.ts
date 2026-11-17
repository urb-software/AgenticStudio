import type { Project } from '../entities/project.js';
import type { ProjectSnapshot } from '../value-objects/project-snapshot.js';

export interface ProjectRepository {
  add(project: Project): Promise<void>;
  list(): Promise<ProjectSnapshot[]>;
}
