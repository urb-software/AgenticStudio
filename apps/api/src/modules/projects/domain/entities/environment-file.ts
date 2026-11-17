/**
 * What the operator may see of a Project's Environment file, as read-only plain data: the
 * path, the size and the last change. It carries neither the content nor the secret store's
 * reference to it (security.md §3). The file is identified by its Project's id, which the
 * caller already holds, so the snapshot does not repeat it.
 */
export interface EnvironmentFileSnapshot {
  /** Relative POSIX path in the repository. */
  readonly path: string;
  /** UTF-8 bytes of the content. */
  readonly sizeBytes: number;
  /** When it was last set. */
  readonly updatedAt: Date;
}

/** What a store holds of an Environment file: the visible fields and the content's reference. */
export interface StoredEnvironmentFile extends EnvironmentFileSnapshot {
  /** The Project it belongs to: at most one Environment file per Project. */
  readonly projectId: string;
  /** The secret store's reference to the content; never the content. */
  readonly secretRef: string;
}

/**
 * The Environment file aggregate root (Issue #104): one file of test settings that Studio
 * places in each Run's Working copy, kept apart from the Project and from its Repository
 * connection, so disconnecting the Repository leaves it in place. The content lives in the
 * secret store; the class holds the reference to it and reads of it never leave the class as
 * plain data. The path and content rules are checked before a file is stored (`check.ts` of
 * `set-environment-file`), so the class is thin: it is made only by
 * {@link EnvironmentFile.restore} and produces its {@link snapshot}.
 */
export class EnvironmentFile {
  readonly projectId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly updatedAt: Date;
  /** The secret store's reference to the content. */
  readonly secretRef: string;

  private constructor(stored: StoredEnvironmentFile) {
    this.projectId = stored.projectId;
    this.path = stored.path;
    this.sizeBytes = stored.sizeBytes;
    this.updatedAt = stored.updatedAt;
    this.secretRef = stored.secretRef;
  }

  /** An Environment file as storage holds it. */
  static restore(stored: StoredEnvironmentFile): EnvironmentFile {
    return new EnvironmentFile(stored);
  }

  /** What the operator may see (a copy): never the content, never its reference. */
  snapshot(): EnvironmentFileSnapshot {
    return {
      path: this.path,
      sizeBytes: this.sizeBytes,
      updatedAt: new Date(this.updatedAt),
    };
  }
}
