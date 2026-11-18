import type { Project } from '../entities/project.js';

export class ProjectNameTakenError extends Error {
  constructor(name: string) {
    super(`Project name taken: ${name}`);
  }
}

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
}
