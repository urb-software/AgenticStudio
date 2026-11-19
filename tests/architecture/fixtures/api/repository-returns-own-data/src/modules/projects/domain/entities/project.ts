import type { ProjectData } from './project-data.js';

export class Project {
  private constructor(readonly name: string) {}

  static restore(data: ProjectData): Project {
    return new Project(data.name);
  }
}
