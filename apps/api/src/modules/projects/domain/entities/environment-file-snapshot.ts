/**
 * What the operator may see of a Project's Environment file, as read-only plain data: never the
 * content, never the secret store's reference to it (security.md §3).
 */
export interface EnvironmentFileSnapshot {
  readonly path: string;
  readonly sizeBytes: number;
  readonly updatedAt: Date;
}

export interface StoredEnvironmentFile extends EnvironmentFileSnapshot {
  /** The Project it belongs to: at most one Environment file per Project. */
  readonly projectId: string;
  /** The secret store's reference to the content; never the content. */
  readonly secretRef: string;
}
