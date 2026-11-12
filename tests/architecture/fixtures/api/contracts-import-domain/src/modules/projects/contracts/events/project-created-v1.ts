import type { Project } from '../../domain/entities/project.js';

export interface ProjectCreatedV1 {
  version: 1;
  project: Project;
}
