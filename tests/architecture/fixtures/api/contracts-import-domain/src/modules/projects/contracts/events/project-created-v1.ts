import type { Project } from '../../domain/value-objects/project.js';

export interface ProjectCreatedV1 {
  version: 1;
  project: Project;
}
