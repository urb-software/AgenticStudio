import type { Project } from '../entities/project.js';

export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

export interface ProjectRepository {
  findById(id: string): Promise<Project | null>;
  add(name: string): Promise<void>;
}
