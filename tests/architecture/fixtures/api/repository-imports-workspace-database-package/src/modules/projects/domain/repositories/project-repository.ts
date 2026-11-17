import type { Project } from '../entities/project.js';

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  add(name: string): Promise<void>;
}
