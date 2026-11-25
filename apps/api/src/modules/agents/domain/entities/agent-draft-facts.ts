/** One tracked item of the base commit's tree. */
export interface AgentDraftBaseEntry {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'submodule' | 'other';
}

/** What every change to the Draft needs of the Repository. */
export interface AgentDraftBaseFacts {
  /** The commit the Repository holds now; null when none. An empty Draft takes it as its base. */
  readonly currentCommit: string | null;
  /** The whole tree of the Draft's base commit (of the current commit while the Draft is empty). */
  readonly baseEntries: readonly AgentDraftBaseEntry[];
  readonly now: Date;
}
