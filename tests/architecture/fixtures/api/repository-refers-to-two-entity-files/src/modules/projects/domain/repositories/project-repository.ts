import type { Project } from '../entities/project.js';
import type { RepositoryConnection } from '../entities/repository.js';

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  findRepository(projectId: string): Promise<RepositoryConnection | null>;
}
