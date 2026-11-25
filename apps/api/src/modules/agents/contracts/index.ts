export const AGENT_RESOLUTION = Symbol('AGENT_RESOLUTION');

/** The agent as a Run records it at start. */
export interface ResolvedAgent {
  name: string;
  source: 'built_in' | 'definitions';
  /** The definitions Repository commit the agent was read at; `null` for a built-in agent. */
  commit: string | null;
  provider: 'claude_code' | 'codex';
  /** The model the definition names; `default` is the CLI's own. */
  model: string;
  /** Empty for a built-in agent. */
  instructions: string;
}

/**
 * `unknown`: no agent has this name at the current commit. `not_usable`: a folder has the name but
 * its definition has problems.
 */
export type AgentResolution =
  { status: 'resolved'; agent: ResolvedAgent } | { status: 'unknown' | 'not_usable' };

export interface AgentResolutions {
  /**
   * The agent of this name as it stands at the definitions Repository's last fetched commit, or
   * why none can be used. A built-in agent needs no Repository.
   */
  resolveForRun(name: string): Promise<AgentResolution>;
}
