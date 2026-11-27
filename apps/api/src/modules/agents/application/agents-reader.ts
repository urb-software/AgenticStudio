import {
  AGENT_ENTRY_FILE,
  agentSkillNames,
  AGENTS_DIRECTORY,
  checkAgentSkills,
  findAgentFolders,
  MAX_FILE_BYTES,
  MODEL_DEFAULT,
  type Problem,
  type Provider,
  PROVIDERS,
  validateAgentFolder,
  WORKFLOW_ENTRY_FILE,
  WORKFLOWS_DIRECTORY,
  findWorkflowFolders,
  workflowAgentNames,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_FILES,
  type DefinitionsFileRead,
  type DefinitionsFiles,
  type DefinitionsUnavailable,
  type RepositoryState,
} from '../../projects/contracts/index.js';
import { MAX_READ_BYTES, MAX_READ_PATHS, SkillsReader } from './skills-reader.js';

/** Most agent folders listed; the rest are cut and the result says so. */
export const MAX_LISTED_AGENTS = 200;

/** Most workflow folders looked at for the agent's users; the rest are cut and the answer says so. */
export const MAX_LISTED_WORKFLOW_FOLDERS = 200;

/**
 * Most unlisted agent names judged by name per commit beyond a cut list, in one listing and one
 * read of their entry files; the rest count as invalid, the same on every request.
 */
export const MAX_ON_DEMAND_AGENTS = 200;

/** What a workflow needs to know of an agent that exists at a commit. */
export interface AgentStandingView {
  valid: boolean;
  /** `null` for an agent that is not valid. */
  provider: Provider | null;
}

export interface AgentStandings {
  /** An agent that exists, whether it is valid; a name that does not exist is absent. */
  standings: Map<string, AgentStandingView>;
  /** False after a transient read failure: the answer must not be kept for the commit. */
  settled: boolean;
}

const INVALID: AgentStandingView = { valid: false, provider: null };

export interface AgentView {
  name: string;
  /** `null` for an agent that is not usable. */
  description: string | null;
  provider: Provider | null;
  model: string | null;
  source: 'built_in' | 'definitions';
  usable: boolean;
  problems: Problem[];
  /** The skills the front matter names, as listed; empty when none or it cannot be read. */
  skills: string[];
  /** The Markdown after the front matter; empty for a built-in agent and a refused one. */
  instructions: string;
  files: { path: string; size: number }[];
}

export interface AgentsRead {
  /** The commit the definitions agents were read at; `null` when none were read. */
  commit: string | null;
  /** `null` when no definitions Repository is connected. */
  repository: { state: RepositoryState; note: string | null } | null;
  truncated: boolean;
  agents: AgentView[];
}

const PROVIDER_LABELS: Record<Provider, string> = { claude_code: 'Claude Code', codex: 'Codex' };

/** One Default agent per Provider: always listed, usable with no Repository, no instructions. */
const BUILT_IN_AGENTS: AgentView[] = PROVIDERS.map((provider) => ({
  name: `default-${provider.replaceAll('_', '-')}`,
  description: `${PROVIDER_LABELS[provider]} with the base rules of Studio only.`,
  provider,
  model: MODEL_DEFAULT,
  source: 'built_in',
  usable: true,
  problems: [],
  skills: [],
  instructions: '',
  files: [],
}));

const STATE_NOTES: Record<Exclude<RepositoryState, 'ready'>, string> = {
  awaiting_key: 'The Repository is waiting for its Deploy key to be added to the Git host.',
  awaiting_host_key: 'The Repository is waiting for the key of the Git host to be confirmed.',
  connecting: 'The Repository is being connected.',
  fetching: 'A fetch of the Repository is running.',
  failed: 'The last operation on the Repository failed.',
  disconnecting: 'The Repository is being disconnected.',
};

const UNAVAILABLE_NOTES: Record<DefinitionsUnavailable, string> = {
  repository_not_ready: 'The Repository has no Clone to read agents from.',
  unsupported_platform: 'Studio can read the definitions Repository only on Linux.',
  commit_missing: 'The Clone of the Repository does not hold that commit.',
  failed: 'The Clone of the Repository could not be read.',
};

/** Commits whose judged list is kept. */
const MEMOISED_COMMITS = 4;

/** `settled` is false when a named skill could not be judged: the list is not kept. */
type ReadOk = { status: 'read'; agents: AgentView[]; truncated: boolean; settled: boolean };
type Read = ReadOk | { status: DefinitionsUnavailable };

/** The agent names each workflow folder's entry file lists, by workflow name. */
type WorkflowAgentsRead =
  | { status: 'read'; workflows: Map<string, string[]>; truncated: boolean }
  | { status: DefinitionsUnavailable };

const builtIns = (name: string | undefined) =>
  BUILT_IN_AGENTS.filter((agent) => name === undefined || agent.name === name);

/**
 * The built-in Default agents and the definitions found in the definitions Repository's Clone at
 * the last fetched commit, judged by the shared validation and by the skills they name. Shared by
 * the agents use case and by the skills one (which agents use a skill).
 */
@Injectable()
export class AgentsReader {
  private readonly memo = new Map<string, ReadOk>();
  private readonly workflowMemo = new Map<
    string,
    Extract<WorkflowAgentsRead, { status: 'read' }>
  >();

  constructor(
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    private readonly skills: SkillsReader,
  ) {}

  /** The names of the agents at the commit whose front matter lists the skill, valid or not. */
  async skillUsers(
    commit: string,
    skill: string,
  ): Promise<{ users: string[]; truncated: boolean }> {
    const read = await this.readMemoised(commit, undefined);
    if (read.status !== 'read') return { users: [], truncated: true };
    const users = read.agents
      .filter((agent) => agent.source === 'definitions' && agent.skills.includes(skill))
      .map((agent) => agent.name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { users, truncated: read.truncated };
  }

  /**
   * The names of the workflows at the commit whose entry file lists the agent in a phase, valid or
   * not. Fails closed: when the folders cannot be read, no user is named and the answer is cut.
   */
  async workflowUsers(
    commit: string,
    agent: string,
  ): Promise<{ users: string[]; truncated: boolean }> {
    const read = await this.readWorkflowAgents(commit);
    if (read.status !== 'read') return { users: [], truncated: true };
    const users = [...read.workflows]
      .filter(([, agents]) => agents.includes(agent))
      .map(([name]) => name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { users, truncated: read.truncated };
  }

  /**
   * Whether each named definitions agent exists and is usable, with its Provider; a missing one is
   * absent. One that cannot be judged counts as invalid, not missing. Built-in agents are not
   * judged here: a name a built-in agent has is absent unless a folder has it too.
   */
  async standings(commit: string, names: readonly string[]): Promise<AgentStandings> {
    const unique = [...new Set(names)].sort();
    const listed = await this.readMemoised(commit, undefined);
    const unjudged = (): AgentStandings => ({
      standings: new Map(unique.map((name) => [name, INVALID])),
      settled: false,
    });
    if (listed.status !== 'read') return unjudged();
    const known = new Map(
      listed.agents.map((agent): [string, AgentStandingView] => [agent.name, standingOf(agent)]),
    );
    let settled = listed.settled;
    if (listed.truncated) {
      const pending = unique.filter((name) => !known.has(name));
      if (pending.length > 0) {
        const alone = await this.readDefinitions(commit, pending.slice(0, MAX_ON_DEMAND_AGENTS));
        if (alone.status !== 'read') return unjudged();
        settled = settled && alone.settled;
        for (const agent of alone.agents) known.set(agent.name, standingOf(agent));
        for (const name of pending) {
          // A cut listing may hide the folder, and so may the cap on names: never "missing".
          if (
            !known.has(name) &&
            (alone.truncated || pending.indexOf(name) >= MAX_ON_DEMAND_AGENTS)
          ) {
            known.set(name, INVALID);
          }
        }
      }
    }
    const standings = new Map<string, AgentStandingView>();
    for (const name of unique) {
      const standing = known.get(name);
      if (standing !== undefined) standings.set(name, standing);
    }
    return { standings, settled };
  }

  async read(name: string | undefined): Promise<AgentsRead> {
    const snapshot = await this.definitions.snapshot();
    if (!snapshot) {
      return { commit: null, repository: null, truncated: false, agents: builtIns(name) };
    }
    const stateNote = snapshot.state === 'ready' ? null : STATE_NOTES[snapshot.state];
    const unread = (note: string): AgentsRead => ({
      commit: null,
      repository: { state: snapshot.state, note },
      truncated: false,
      agents: builtIns(name),
    });
    if (snapshot.commit === null) {
      return unread(
        `${stateNote ?? UNAVAILABLE_NOTES.repository_not_ready} No agents are read from it yet.`,
      );
    }
    const read = await this.readMemoised(snapshot.commit, name);
    if (read.status !== 'read') return unread(UNAVAILABLE_NOTES[read.status]);
    return {
      commit: snapshot.commit,
      repository: {
        state: snapshot.state,
        note: stateNote ? `${stateNote} These are the agents at the last fetched commit.` : null,
      },
      truncated: read.truncated,
      agents: [...builtIns(name), ...read.agents],
    };
  }

  /**
   * What a commit holds never changes, so the judged list of a commit is kept for the next
   * requests (a page refetching on focus starts no Git process); a new commit is a new key. The
   * four latest commits asked for are kept.
   */
  private async readMemoised(commit: string, name: string | undefined): Promise<Read> {
    let all = this.memo.get(commit);
    if (all) {
      this.memo.delete(commit);
    } else {
      const read = await this.readDefinitions(commit, undefined);
      if (read.status !== 'read') return read;
      all = read;
    }
    if (all.settled) {
      this.memo.set(commit, all);
      while (this.memo.size > MEMOISED_COMMITS) this.memo.delete(this.memo.keys().next().value!);
    }
    if (name === undefined) return all;
    const found = all.agents.filter((agent) => agent.name === name);
    // A folder beyond the listed ones is read by itself.
    if (found.length === 0 && all.truncated) return this.readDefinitions(commit, [name]);
    return { status: 'read', agents: found, truncated: all.truncated, settled: all.settled };
  }

  /**
   * What a commit holds never changes, so the answer is kept per commit (the four latest). The
   * entry files read stay inside the read budget by their declared sizes; a larger one cannot be
   * a valid workflow and is not read.
   */
  private async readWorkflowAgents(commit: string): Promise<WorkflowAgentsRead> {
    const kept = this.workflowMemo.get(commit);
    if (kept) {
      this.workflowMemo.delete(commit);
      this.workflowMemo.set(commit, kept);
      return kept;
    }
    const tree = await this.definitions.listTree(commit, { directory: WORKFLOWS_DIRECTORY });
    if (tree.status !== 'listed') return tree;

    let folders = findWorkflowFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not read.
    if (tree.truncated) folders = folders.slice(0, -1);
    folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let truncated = tree.truncated || folders.length > MAX_LISTED_WORKFLOW_FOLDERS;

    const paths: string[] = [];
    let bytes = 0;
    for (const folder of folders.slice(0, MAX_LISTED_WORKFLOW_FOLDERS)) {
      const entry = folder.entries.find(
        (item) => item.path === WORKFLOW_ENTRY_FILE && item.kind === 'file',
      );
      if (!entry || entry.size > MAX_FILE_BYTES) continue;
      if (paths.length + 1 > MAX_READ_PATHS || bytes + entry.size > MAX_READ_BYTES) {
        truncated = true;
        break;
      }
      paths.push(`${WORKFLOWS_DIRECTORY}/${folder.name}/${WORKFLOW_ENTRY_FILE}`);
      bytes += entry.size;
    }

    const workflows = new Map<string, string[]>();
    if (paths.length > 0) {
      const files = await this.definitions.readFiles(commit, paths, MAX_FILE_BYTES);
      if (files.status !== 'read') return files;
      for (const file of files.files) {
        if (file.status !== 'found' || file.binary) continue;
        const name = file.path.slice(
          WORKFLOWS_DIRECTORY.length + 1,
          -WORKFLOW_ENTRY_FILE.length - 1,
        );
        workflows.set(name, workflowAgentNames(file.text));
      }
    }
    const read = { status: 'read' as const, workflows, truncated };
    this.workflowMemo.set(commit, read);
    while (this.workflowMemo.size > MEMOISED_COMMITS) {
      this.workflowMemo.delete(this.workflowMemo.keys().next().value!);
    }
    return read;
  }

  /** Reads the folders of these names only, or, without names, the first {@link MAX_LISTED_AGENTS}. */
  private async readDefinitions(
    commit: string,
    names: readonly string[] | undefined,
  ): Promise<Read> {
    const tree = await this.definitions.listTree(commit);
    if (tree.status !== 'listed') return tree;

    let folders = findAgentFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    const truncated = tree.truncated || (names === undefined && folders.length > MAX_LISTED_AGENTS);
    const wanted = names === undefined ? undefined : new Set(names);
    const chosen = folders
      .filter((folder) => wanted === undefined || wanted.has(folder.name))
      .slice(0, MAX_LISTED_AGENTS);

    const entryPath = (folder: string) => `${AGENTS_DIRECTORY}/${folder}/${AGENT_ENTRY_FILE}`;
    const withEntry = chosen.filter((folder) =>
      folder.entries.some((entry) => entry.path === AGENT_ENTRY_FILE && entry.kind === 'file'),
    );
    const contents = new Map<string, DefinitionsFileRead>();
    if (withEntry.length > 0) {
      const files = await this.definitions.readFiles(
        commit,
        withEntry.map((folder) => entryPath(folder.name)),
        MAX_FILE_BYTES,
      );
      if (files.status !== 'read') return files;
      for (const file of files.files) contents.set(file.path, file);
    }

    const judgedFolders = chosen.map((folder) => {
      const entry = contents.get(entryPath(folder.name));
      const text = entry?.status === 'found' && !entry.binary ? entry.text : undefined;
      const judged = validateAgentFolder(
        folder.name,
        folder.entries.map((item) =>
          item.path === AGENT_ENTRY_FILE && text !== undefined ? { ...item, content: text } : item,
        ),
      );
      return { folder, text, judged };
    });

    // Skills are looked at only for agents that name some, at the commit of the agents.
    const named = judgedFolders.flatMap(({ judged }) =>
      judged.ok ? judged.definition.skills : [],
    );
    let settled = true;
    let standings = new Map<string, { valid: boolean }>();
    if (named.length > 0) {
      const judgedSkills = await this.skills.standings(commit, named);
      standings = judgedSkills.standings;
      settled = judgedSkills.settled;
    }

    const agents = judgedFolders.map(({ folder, text, judged }): AgentView => {
      const files = folder.entries
        .filter((item) => item.kind === 'file')
        .map(({ path, size }) => ({ path, size }));
      if (judged.ok) {
        const { definition } = judged;
        const problems = checkAgentSkills(definition, standings);
        if (problems.length === 0) {
          return {
            name: definition.name,
            description: definition.description,
            provider: definition.provider,
            model: definition.model,
            source: 'definitions',
            usable: true,
            problems: [],
            skills: definition.skills,
            instructions: definition.instructions,
            files: definition.files,
          };
        }
        return unusable(folder.name, problems, definition.skills, files);
      }
      const skills = text === undefined ? [] : agentSkillNames(text);
      return unusable(folder.name, judged.problems, skills, files);
    });
    return { status: 'read', agents, truncated, settled };
  }
}

function standingOf(agent: AgentView): AgentStandingView {
  return agent.usable ? { valid: true, provider: agent.provider } : INVALID;
}

function unusable(
  name: string,
  problems: Problem[],
  skills: string[],
  files: { path: string; size: number }[],
): AgentView {
  return {
    name,
    description: null,
    provider: null,
    model: null,
    source: 'definitions',
    usable: false,
    problems,
    skills,
    instructions: '',
    files,
  };
}
