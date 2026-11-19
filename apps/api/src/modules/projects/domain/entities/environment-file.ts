import type { EnvironmentFileContent } from '../value-objects/environment-file-content.js';
import type { EnvironmentFilePath } from '../value-objects/environment-file-path.js';
import type { EnvironmentFileData } from './environment-file-data.js';

/**
 * The Environment file aggregate: it holds the secret store's reference to the content, never the
 * content, and is made only by {@link EnvironmentFile.create} or {@link EnvironmentFile.restore}.
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

  /** `secretRef` is the secret store's reference to `content`, which the entity does not keep. */
  static create(input: {
    projectId: string;
    path: EnvironmentFilePath;
    content: EnvironmentFileContent;
    secretRef: string;
    now: Date;
  }): EnvironmentFile {
    return new EnvironmentFile({
      projectId: input.projectId,
      path: input.path.value,
      sizeBytes: input.content.sizeBytes,
      updatedAt: input.now,
      secretRef: input.secretRef,
    });
  }

  static restore(data: EnvironmentFileData): EnvironmentFile {
    return new EnvironmentFile(data);
  }
}
