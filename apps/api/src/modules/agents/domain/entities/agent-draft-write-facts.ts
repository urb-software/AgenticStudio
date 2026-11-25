import type { AgentDraftBaseFacts } from './agent-draft-facts.js';

/** What storing one file's content in the Draft needs. */
export interface AgentDraftWriteFacts extends AgentDraftBaseFacts {
  readonly path: string;
  /** The content's size in bytes. */
  readonly size: number;
}
