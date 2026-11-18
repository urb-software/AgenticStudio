/** The Environment file's path, size and time as read-only plain data: never the content. */
export interface EnvironmentFileSnapshot {
  readonly path: string;
  /** UTF-8 bytes of the content. */
  readonly sizeBytes: number;
  readonly updatedAt: Date;
}

export interface StoredEnvironmentFile extends EnvironmentFileSnapshot {
  /** The Project it belongs to: at most one Environment file per Project. */
  readonly projectId: string;
  /** The secret store's reference to the content; never the content. */
  readonly secretRef: string;
}
