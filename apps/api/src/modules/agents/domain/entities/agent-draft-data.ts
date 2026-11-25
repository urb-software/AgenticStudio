import type { AgentDraftFileData } from '../value-objects/agent-draft-file.js';

/** What the one Draft is restored from. */
export interface AgentDraftData {
  /** The commit the changes were made against; null exactly while the Draft changes no file. */
  readonly baseCommit: string | null;
  /** Raised on every write. */
  readonly version: number;
  readonly updatedAt: Date;
  readonly files: readonly AgentDraftFileData[];
}
