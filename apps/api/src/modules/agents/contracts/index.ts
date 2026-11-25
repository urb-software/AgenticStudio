import type { Problem } from '@agentic-studio/agent-definitions';

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

export const AGENT_FOLDERS = Symbol('AGENT_FOLDERS');

/** One file of an agent's folder as stored in Git: its bytes and whether Git marks it executable. */
export interface AgentFolderFile {
  /** Relative to the agent's folder, with `/` separators. */
  path: string;
  executable: boolean;
  content: Uint8Array;
}

/**
 * `found`: the folder's files except `AGENT.md`. `invalid`: it fails the shared validation.
 * `unavailable`: gone at that commit. `unreadable`: not readable now (`read_failed`: retry may
 * work; `tree_cut`: the listing was cut, so the folder may be partial).
 */
export type AgentFolderRead =
  | { status: 'found'; files: AgentFolderFile[] }
  | { status: 'invalid'; problems: Problem[] }
  | { status: 'unavailable' }
  | { status: 'unreadable'; reason: 'read_failed' | 'tree_cut' };

export interface AgentFolders {
  /** The folder of the agent `name` at `commit` of the definitions Repository, from Git only. */
  folderAt(name: string, commit: string): Promise<AgentFolderRead>;
}
