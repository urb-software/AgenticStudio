import type { ProjectSnapshot } from '../value-objects/project-snapshot.js';

export class Project {
  private constructor(readonly name: string) {}

  static restore(name: string): Project {
    return new Project(name);
  }

  snapshot(): ProjectSnapshot {
    return { name: this.name };
  }
}
