/** A Project's current values as read-only plain data: what a handler returns of it. */
export interface ProjectSnapshot {
  readonly id: string;
  /** Display name: normalized (see `ProjectName`), case preserved. */
  readonly name: string;
  readonly createdAt: Date;
}

/**
 * The Project aggregate root: the operator's unit of work (glossary). It has no rule beyond
 * its value objects yet (`ProjectName` validates the name before the store creates it, and
 * nothing changes a Project afterwards), so the class is thin: it is made only by
 * {@link Project.restore} from what the store holds, and produces its {@link snapshot}.
 * Its Repository connection and its Environment file are separate roots that refer to it by
 * id (backend.md §3 rule 12).
 */
export class Project {
  readonly id: string;
  readonly name: string;
  readonly createdAt: Date;

  private constructor(stored: ProjectSnapshot) {
    this.id = stored.id;
    this.name = stored.name;
    this.createdAt = stored.createdAt;
  }

  /** A Project as storage holds it. */
  static restore(stored: ProjectSnapshot): Project {
    return new Project(stored);
  }

  /** The values as a plain record (a copy), for what crosses a boundary. */
  snapshot(): ProjectSnapshot {
    return { id: this.id, name: this.name, createdAt: new Date(this.createdAt) };
  }
}
