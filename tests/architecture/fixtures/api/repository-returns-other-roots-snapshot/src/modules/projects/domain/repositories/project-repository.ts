import type { Project } from '../entities/project.js';
import type { EnvironmentFileSnapshot } from '../value-objects/environment-file-snapshot.js';

export interface ProjectRepository {
  add(project: Project): Promise<void>;
  findEnvironmentFile(id: string): Promise<EnvironmentFileSnapshot | null>;
}
