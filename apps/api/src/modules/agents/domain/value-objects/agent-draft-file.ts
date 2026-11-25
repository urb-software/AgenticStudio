import type { AgentDraftFileSize } from './agent-draft-file-size.js';
import type { AgentDraftPath } from './agent-draft-path.js';

export const AGENT_DRAFT_CHANGES = ['added', 'modified', 'deleted'] as const;
export type AgentDraftChange = (typeof AGENT_DRAFT_CHANGES)[number];

export interface AgentDraftFileData {
  readonly path: string;
  readonly change: AgentDraftChange;
  /** Bytes; 0 for a deleted file. */
  readonly size: number;
  /** For display: the path this file was moved from. Never set on a deleted file. */
  readonly movedFrom: string | null;
  readonly updatedAt: Date;
}

/** One changed file of the Draft: added, modified or deleted against the base commit. */
export class AgentDraftFile {
  private constructor(
    readonly path: string,
    readonly change: AgentDraftChange,
    readonly size: number,
    readonly movedFrom: string | null,
    readonly updatedAt: Date,
  ) {}

  /** A file that the base commit does not hold. */
  static added(input: {
    path: AgentDraftPath;
    size: AgentDraftFileSize;
    movedFrom: string | null;
    now: Date;
  }): AgentDraftFile {
    return new AgentDraftFile(
      input.path.value,
      'added',
      input.size.bytes,
      input.movedFrom,
      input.now,
    );
  }

  /** A file that the base commit holds, with other content. */
  static modified(input: {
    path: AgentDraftPath;
    size: AgentDraftFileSize;
    movedFrom: string | null;
    now: Date;
  }): AgentDraftFile {
    return new AgentDraftFile(
      input.path.value,
      'modified',
      input.size.bytes,
      input.movedFrom,
      input.now,
    );
  }

  /** A file that the base commit holds and the Draft removes. */
  static removed(input: { path: AgentDraftPath; now: Date }): AgentDraftFile {
    return new AgentDraftFile(input.path.value, 'deleted', 0, null, input.now);
  }

  static restore(data: AgentDraftFileData): AgentDraftFile {
    return new AgentDraftFile(
      data.path,
      data.change,
      data.size,
      data.movedFrom,
      new Date(data.updatedAt),
    );
  }

  get isDeleted(): boolean {
    return this.change === 'deleted';
  }

  toData(): AgentDraftFileData {
    return {
      path: this.path,
      change: this.change,
      size: this.size,
      movedFrom: this.movedFrom,
      updatedAt: this.updatedAt,
    };
  }
}
