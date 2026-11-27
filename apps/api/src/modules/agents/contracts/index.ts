import type { Problem, Provider } from '@agentic-studio/agent-definitions';

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
  /** The names of the skills the definition lists, in its order; empty for a built-in agent. */
  skills: string[];
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

export const AGENT_SKILLS = Symbol('AGENT_SKILLS');

/** What a claim says of one skill of a Run. */
export interface RunSkillDescription {
  name: string;
  description: string;
}

/** One skill's files, `SKILL.md` included, relative to the skill's folder. */
export interface RunSkillFiles {
  name: string;
  files: AgentFolderFile[];
}

/** Why the Run's skills cannot be handed out; `problems` name a skill, a code and a path only. */
export type RunSkillsFailure =
  | { status: 'invalid'; problems: { skill: string; code: string; path: string }[] }
  | { status: 'unavailable' }
  | { status: 'unreadable' };

export type RunSkillDescriptionsRead =
  { status: 'found'; skills: RunSkillDescription[] } | RunSkillsFailure;

/**
 * `omitted`: the skills left out because those before them already used the Run's byte budget.
 */
export type RunSkillFilesRead =
  { status: 'found'; skills: RunSkillFiles[]; omitted: string[] } | RunSkillsFailure;

export interface AgentSkills {
  /** The description of each named skill at `commit`, in the order of `names`, judged by the shared validation. */
  describe(names: readonly string[], commit: string): Promise<RunSkillDescriptionsRead>;
  /** The files of each named skill at `commit`, in the order of `names`, from Git only. */
  files(names: readonly string[], commit: string): Promise<RunSkillFilesRead>;
}

export const AGENT_STANDINGS = Symbol('AGENT_STANDINGS');

/** What the definitions agents of a commit look like to a module that names them. */
export interface DefinitionAgentStanding {
  /** True when the agent's definition and the skills it names are all valid. */
  valid: boolean;
  /** `null` for an agent that is not valid. */
  provider: Provider | null;
}

export interface DefinitionAgentStandings {
  /** A definitions agent that exists, valid or not; a name that does not exist is absent. */
  standings: ReadonlyMap<string, DefinitionAgentStanding>;
  /** False after a transient read failure: the answer must not be kept for the commit. */
  settled: boolean;
}

export interface AgentStandings {
  /**
   * The named definitions agents at `commit` (built-in agents are not definitions). An agent that
   * cannot be judged counts as invalid, never as missing.
   */
  at(commit: string, names: readonly string[]): Promise<DefinitionAgentStandings>;
}
