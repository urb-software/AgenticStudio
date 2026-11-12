import type { ProjectName } from '../value-objects/project-name.js';

export interface Project {
  id: string;
  name: ProjectName;
}
