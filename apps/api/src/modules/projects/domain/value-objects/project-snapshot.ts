/** A Project's current values as read-only plain data: what a handler returns of it. */
export interface ProjectSnapshot {
  readonly id: string;
  /** Display name: normalized (see `ProjectName`), case preserved. */
  readonly name: string;
  readonly createdAt: Date;
}
