import type { EnvironmentFile } from '../domain/entities/environment-file.js';

/** What the operator may see of an Environment file: never its content or its secret reference. */
export interface EnvironmentFileView {
  path: string;
  /** UTF-8 bytes of the content. */
  sizeBytes: number;
  updatedAt: Date;
}

export function environmentFileView(file: EnvironmentFile): EnvironmentFileView {
  return { path: file.path, sizeBytes: file.sizeBytes, updatedAt: new Date(file.updatedAt) };
}
