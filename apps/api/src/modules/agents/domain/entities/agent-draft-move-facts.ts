import type { AgentDraftBaseFacts } from './agent-draft-facts.js';

/** What moving one file inside the Draft needs. */
export interface AgentDraftMoveFacts extends AgentDraftBaseFacts {
  readonly from: string;
  readonly to: string;
  /** The size in bytes of the content that moves. */
  readonly size: number;
}
