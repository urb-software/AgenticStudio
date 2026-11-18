import type {
  EnvironmentFileSnapshot,
  StoredEnvironmentFile,
} from './environment-file-snapshot.js';

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
