/** What a Project is restored from. */
export interface ProjectData {
  readonly id: string;
  /** Display name: normalized (see `ProjectName`), case preserved. */
  readonly name: string;
  readonly createdAt: Date;
}
