import type { ProjectSnapshot } from './project-snapshot.js';

export class Project {
  private constructor(readonly name: string) {}

  static restore(name: string): Project {
    return new Project(name);
  }

  snapshot(): ProjectSnapshot {
    return { name: this.name };
  }
}
