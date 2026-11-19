/** What an Environment file is restored from: its path, size and time, never the content. */
export interface EnvironmentFileData {
  /** The Project it belongs to: at most one Environment file per Project. */
  readonly projectId: string;
  readonly path: string;
  /** UTF-8 bytes of the content. */
  readonly sizeBytes: number;
  readonly updatedAt: Date;
  /** The secret store's reference to the content; never the content. */
  readonly secretRef: string;
}
