import type { Project } from '../entities/project.js';
import type { EnvironmentFileData } from '../entities/environment-file-data.js';

export interface ProjectRepository {
  add(project: Project): Promise<void>;
  findEnvironmentFile(id: string): Promise<EnvironmentFileData | null>;
}
