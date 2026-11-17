import type { Project } from '../entities/project.js';
import type { ProjectSummary } from '../value-objects/project-summary.js';

export interface ProjectRepository {
  add(project: Project): Promise<void>;
  findSummary(id: string): Promise<ProjectSummary | null>;
}
