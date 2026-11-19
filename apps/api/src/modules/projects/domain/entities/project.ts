import type { ProjectData } from './project-data.js';

export class Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;

  private constructor(data: ProjectData) {
    this.id = data.id;
    this.name = data.name;
    this.createdAt = new Date(data.createdAt);
  }

  static restore(data: ProjectData): Project {
    return new Project(data);
  }
}
