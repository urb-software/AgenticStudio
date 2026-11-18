import type {
  EnvironmentFileSnapshot,
  StoredEnvironmentFile,
} from './environment-file-snapshot.js';

/**
 * The Environment file aggregate: it holds the secret store's reference to the content, never the
 * content, and is made only by {@link EnvironmentFile.restore}.
 */
export class EnvironmentFile {
  readonly projectId: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly updatedAt: Date;
  readonly secretRef: string;

  private constructor(stored: StoredEnvironmentFile) {
    this.projectId = stored.projectId;
    this.path = stored.path;
    this.sizeBytes = stored.sizeBytes;
    this.updatedAt = stored.updatedAt;
    this.secretRef = stored.secretRef;
  }

  static restore(stored: StoredEnvironmentFile): EnvironmentFile {
    return new EnvironmentFile(stored);
  }

  snapshot(): EnvironmentFileSnapshot {
    return {
      path: this.path,
      sizeBytes: this.sizeBytes,
      updatedAt: new Date(this.updatedAt),
    };
  }
}
