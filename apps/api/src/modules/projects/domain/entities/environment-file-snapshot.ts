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
