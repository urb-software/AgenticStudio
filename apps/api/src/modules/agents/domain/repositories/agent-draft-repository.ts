import type { AgentDraft } from '../entities/agent-draft.js';

export const AGENT_DRAFT_REPOSITORY = Symbol('AGENT_DRAFT_REPOSITORY');

export interface AgentDraftRepository {
  /** The one Draft; an empty one (version 0) when nothing was ever written. */
  find(): Promise<AgentDraft>;

  /**
   * Stores the Draft as the entity holds it. `contents` has the bytes of every file this change
   * added or modified, by path; a file of the Draft that is not in it keeps the bytes it has.
   * Files the entity no longer holds are removed.
   */
  save(draft: AgentDraft, contents: ReadonlyMap<string, Uint8Array>): Promise<void>;

  /** The bytes the Draft holds for a file; `null` for a path the Draft does not add or modify. */
  findContent(path: string): Promise<Uint8Array | null>;

  /** {@link AgentDraftRepository.findContent} for several paths; a path with none is left out. */
  findContents(paths: readonly string[]): Promise<ReadonlyMap<string, Uint8Array>>;
}
