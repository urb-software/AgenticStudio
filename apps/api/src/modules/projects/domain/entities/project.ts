import type { ProjectSnapshot } from './project-snapshot.js';

export class Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;

  private constructor(stored: ProjectSnapshot) {
    this.id = stored.id;
    this.name = stored.name;
    this.createdAt = stored.createdAt;
  }

  static restore(stored: ProjectSnapshot): Project {
    return new Project(stored);
  }

  snapshot(): ProjectSnapshot {
    return { id: this.id, name: this.name, createdAt: new Date(this.createdAt) };
  }
}
