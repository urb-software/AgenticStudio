export type ProjectId = string;

export interface ProjectSnapshot {
  readonly id: ProjectId;
  readonly name: string;
}

export class Project {
  private constructor(
    readonly id: ProjectId,
    readonly name: string,
  ) {}

  static restore(id: ProjectId, name: string): Project {
    return new Project(id, name);
  }

  snapshot(): ProjectSnapshot {
    return { id: this.id, name: this.name };
  }
}
