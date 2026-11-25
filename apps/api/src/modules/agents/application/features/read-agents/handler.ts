import {
  AGENT_ENTRY_FILE,
  AGENTS_DIRECTORY,
  findAgentFolders,
  MAX_FILE_BYTES,
  MODEL_DEFAULT,
  type Problem,
  type Provider,
  PROVIDERS,
  validateAgentFolder,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  PROJECT_DEFAULT_AGENTS,
  type ProjectDefaultAgents,
} from '../../../../projects/contracts/index.js';
import { RunAgentPreselection } from '../../../domain/value-objects/run-agent-preselection.js';
import { isRunnable, RunnableAgent } from '../../../domain/value-objects/runnable-agent.js';
import {
  DEFINITIONS_FILES,
  type DefinitionsFileRead,
  type DefinitionsFiles,
  type DefinitionsUnavailable,
  type RepositoryState,
} from '../../../../projects/contracts/index.js';

/** Most agent folders listed; the rest are cut and the result says so. */
export const MAX_LISTED_AGENTS = 200;

export interface ReadAgentsInput {
  /** Reads this agent only, wherever it sits among the folders. */
  name?: string;
  /** Also answers the agents a Run of this Project offers, and the one to preselect. */
  projectId?: string;
}

export interface AgentView {
  name: string;
  /** `null` for an agent that is not usable. */
  description: string | null;
  provider: Provider | null;
  model: string | null;
  source: 'built_in' | 'definitions';
  usable: boolean;
  problems: Problem[];
  /** The Markdown after the front matter; empty for a built-in agent and a refused one. */
  instructions: string;
  files: { path: string; size: number }[];
}

export interface ReadAgentsResult {
  /** The commit the definitions agents were read at; `null` when none were read. */
  commit: string | null;
  /** `null` when no definitions Repository is connected. */
  repository: { state: RepositoryState; note: string | null } | null;
  truncated: boolean;
  agents: AgentView[];
  /** Only with a `projectId`. */
  forRun?:
    | {
        status: 'offered';
        agents: {
          name: string;
          description: string;
          provider: Provider;
          model: string;
          source: 'built_in' | 'definitions';
        }[];
        preselected: string;
        reason: string | null;
      }
    | { status: 'project_not_found' | 'definitions_project' };
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

type ReadOk = { status: 'read'; agents: AgentView[]; truncated: boolean };
type Read = ReadOk | { status: DefinitionsUnavailable };

const builtIns = (name: string | undefined) =>
  BUILT_IN_AGENTS.filter((agent) => name === undefined || agent.name === name);

/**
 * The built-in Default agents and the definitions found in the definitions Repository's Clone at
 * the last fetched commit, computed on each call and judged by the shared validation only. The list
 * and the single agent are one use case.
 */
@Injectable()
export class ReadAgentsHandler {
  private readonly memo = new Map<string, ReadOk>();

  constructor(
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    @Inject(PROJECT_DEFAULT_AGENTS) private readonly defaults: ProjectDefaultAgents,
  ) {}

  async execute(input: ReadAgentsInput = {}): Promise<ReadAgentsResult> {
    const result = await this.read(input.name);
    if (input.projectId === undefined) return result;
    return { ...result, forRun: await this.offeredFor(input.projectId, result.agents) };
  }

  private async offeredFor(
    projectId: string,
    agents: AgentView[],
  ): Promise<NonNullable<ReadAgentsResult['forRun']>> {
    const stored = await this.defaults.forProject(projectId);
    if (stored.status === 'project_not_found') return stored;
    if (stored.kind === 'definitions') return { status: 'definitions_project' };
    const chosen = RunAgentPreselection.of(
      agents.map((agent) => ({ name: agent.name, usable: isRunnable(agent) })),
      stored.agent,
    );
    return {
      status: 'offered',
      agents: agents.filter(isRunnable).map((agent) => {
        const runnable = RunnableAgent.of(agent);
        return {
          name: runnable.name,
          description: runnable.description,
          provider: runnable.provider,
          model: runnable.model,
          source: runnable.source,
        };
      }),
      preselected: chosen.agent,
      reason: chosen.reason,
    };
  }

  private async read(name: string | undefined): Promise<ReadAgentsResult> {
    const snapshot = await this.definitions.snapshot();
    if (!snapshot) {
      return { commit: null, repository: null, truncated: false, agents: builtIns(name) };
    }
    const stateNote = snapshot.state === 'ready' ? null : STATE_NOTES[snapshot.state];
    const unread = (note: string): ReadAgentsResult => ({
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
    this.memo.set(commit, all);
    while (this.memo.size > MEMOISED_COMMITS) this.memo.delete(this.memo.keys().next().value!);
    if (name === undefined) return all;
    const found = all.agents.filter((agent) => agent.name === name);
    // A folder beyond the listed ones is read by itself.
    if (found.length === 0 && all.truncated) return this.readDefinitions(commit, name);
    return { status: 'read', agents: found, truncated: all.truncated };
  }

  private async readDefinitions(commit: string, name: string | undefined): Promise<Read> {
    const tree = await this.definitions.listTree(commit);
    if (tree.status !== 'listed') return tree;

    let folders = findAgentFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    const truncated = tree.truncated || folders.length > MAX_LISTED_AGENTS;
    const chosen = folders
      .filter((folder) => name === undefined || folder.name === name)
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

    const agents = chosen.map((folder): AgentView => {
      const entry = contents.get(entryPath(folder.name));
      const judged = validateAgentFolder(
        folder.name,
        folder.entries.map((item) =>
          item.path === AGENT_ENTRY_FILE && entry?.status === 'found' && !entry.binary
            ? { ...item, content: entry.text }
            : item,
        ),
      );
      if (judged.ok) {
        const { definition } = judged;
        return {
          name: definition.name,
          description: definition.description,
          provider: definition.provider,
          model: definition.model,
          source: 'definitions',
          usable: true,
          problems: [],
          instructions: definition.instructions,
          files: definition.files,
        };
      }
      return {
        name: folder.name,
        description: null,
        provider: null,
        model: null,
        source: 'definitions',
        usable: false,
        problems: judged.problems,
        instructions: '',
        files: folder.entries
          .filter((item) => item.kind === 'file')
          .map(({ path, size }) => ({ path, size })),
      };
    });
    return { status: 'read', agents, truncated };
  }
}
