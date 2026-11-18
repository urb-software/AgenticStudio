import type { Project } from '../entities/project.js';

export interface ProjectReader {
  findById(id: string): Promise<Project | null>;
  findName(projectId: string): Promise<string | null>;
}
