import type { AgentDraftBaseFacts } from './agent-draft-facts.js';

/** What dropping a change, or deleting a base file, needs. */
export interface AgentDraftDeleteFacts extends AgentDraftBaseFacts {
  readonly path: string;
}
