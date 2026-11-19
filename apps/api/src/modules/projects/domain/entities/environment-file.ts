import type { EnvironmentFileData } from './environment-file-data.js';

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

  private constructor(data: EnvironmentFileData) {
    this.projectId = data.projectId;
    this.path = data.path;
    this.sizeBytes = data.sizeBytes;
    this.updatedAt = new Date(data.updatedAt);
    this.secretRef = data.secretRef;
  }

  static restore(data: EnvironmentFileData): EnvironmentFile {
    return new EnvironmentFile(data);
  }
}
