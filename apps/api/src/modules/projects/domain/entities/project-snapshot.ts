export interface ProjectSnapshot {
  readonly id: string;
  /** Display name: normalized (see `ProjectName`), case preserved. */
  readonly name: string;
  readonly createdAt: Date;
}
