/** A persisted project, as the operator sees it. */
export interface Project {
  id: string;
  /** Display name: normalized (see `ProjectName`), case preserved. */
  name: string;
  createdAt: Date;
}
