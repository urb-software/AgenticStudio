import {
  findWorkflowFolders,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  validateWorkflowFolder,
  WORKFLOW_ENTRY_FILE,
  WORKFLOWS_DIRECTORY,
  type AgentEntry,
  type Provider,
  type WorkflowFolder,
  type WorkflowFolderResult,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import { AGENT_STANDINGS, type AgentStandings } from '../../agents/contracts/index.js';
import {
  DEFINITIONS_FILES,
  type DefinitionsFileRead,
  type DefinitionsFiles,
  type DefinitionsUnavailable,
  type RepositoryState,
} from '../../projects/contracts/index.js';

/** A Workflow folder as the shared validation and the agents its Phases name judge it. */
export interface JudgedWorkflow {
  name: string;
  result: WorkflowFolderResult;
  /** The agents the Phases name that exist at the commit, valid or not. */
  standings: ReadonlyMap<string, { valid: boolean; provider: Provider | null }>;
}

export interface WorkflowDefinitionsRead {
  /** The commit the Workflows were read at; `null` when none were read. */
  commit: string | null;
  /** `null` when no definitions Repository is connected. */
  repository: { state: RepositoryState; note: string | null } | null;
  truncated: boolean;
  workflows: JudgedWorkflow[];
}

/** Most Workflow folders listed; the rest are cut and the result says so. */
export const MAX_LISTED_WORKFLOWS = 200;

/**
 * Most files read for one list, and their declared bytes. Each file is one Git process inside the
 * 10-second read budget of the Clone; a Workflow folder reads its entry file only, so the first
 * folder always fits.
 */
export const MAX_READ_PATHS = 500;
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** Commits whose judged folders are kept. */
const MEMOISED_COMMITS = 4;

export interface WorkflowsReadInput {
  /** Reads this Workflow only, wherever it sits among the folders. */
  name?: string;
}

const STATE_NOTES: Record<Exclude<RepositoryState, 'ready'>, string> = {
  awaiting_key: 'The Repository is waiting for its Deploy key to be added to the Git host.',
  awaiting_host_key: 'The Repository is waiting for the key of the Git host to be confirmed.',
  connecting: 'The Repository is being connected.',
  fetching: 'A fetch of the Repository is running.',
  failed: 'The last operation on the Repository failed.',
  disconnecting: 'The Repository is being disconnected.',
};

const UNAVAILABLE_NOTES: Record<DefinitionsUnavailable, string> = {
  repository_not_ready: 'The Repository has no Clone to read Workflows from.',
  unsupported_platform: 'Studio can read the definitions Repository only on Linux.',
  commit_missing: 'The Clone of the Repository does not hold that commit.',
  failed: 'The Clone of the Repository could not be read.',
};

/** A folder judged by the shared validation alone, before the agents its phases name are. */
interface JudgedFolder {
  name: string;
  result: WorkflowFolderResult;
}

type ReadOk = { status: 'read'; folders: JudgedFolder[]; truncated: boolean };
type Read = ReadOk | { status: DefinitionsUnavailable };

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * The Workflow folders found in the definitions Repository's Clone at the last fetched commit,
 * judged by the shared validation, then against the agents their phases name. The Draft is never
 * read. Shared by the list, the single Workflow and a Run's start; it knows no Provider.
 */
@Injectable()
export class WorkflowDefinitions {
  private readonly memo = new Map<string, ReadOk>();

  constructor(
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    @Inject(AGENT_STANDINGS) private readonly agents: AgentStandings,
  ) {}

  async read(input: WorkflowsReadInput = {}): Promise<WorkflowDefinitionsRead> {
    const snapshot = await this.definitions.snapshot();
    if (!snapshot) return { commit: null, repository: null, truncated: false, workflows: [] };
    const stateNote = snapshot.state === 'ready' ? null : STATE_NOTES[snapshot.state];
    const unread = (note: string): WorkflowDefinitionsRead => ({
      commit: null,
      repository: { state: snapshot.state, note },
      truncated: false,
      workflows: [],
    });
    if (snapshot.commit === null) {
      return unread(
        `${stateNote ?? UNAVAILABLE_NOTES.repository_not_ready} No Workflows are read from it yet.`,
      );
    }
    const read = await this.readMemoised(snapshot.commit, input.name);
    if (read.status !== 'read') return unread(UNAVAILABLE_NOTES[read.status]);
    return {
      commit: snapshot.commit,
      repository: {
        state: snapshot.state,
        note: stateNote ? `${stateNote} These are the Workflows at the last fetched commit.` : null,
      },
      truncated: read.truncated,
      workflows: await this.judge(snapshot.commit, read.folders),
    };
  }

  /** Judges each folder against the agents its Phases name. */
  private async judge(commit: string, folders: JudgedFolder[]): Promise<JudgedWorkflow[]> {
    const names = new Set<string>();
    for (const { result } of folders) {
      if (!result.ok) continue;
      for (const item of result.definition.sequence) {
        if (item.kind !== 'checkpoint') names.add(item.agent);
      }
    }
    if (folders.length === 0) return [];
    const standings =
      names.size === 0
        ? new Map<string, { valid: boolean; provider: Provider | null }>()
        : (await this.agents.at(commit, [...names].sort())).standings;
    return folders.map(({ name, result }) => ({ name, result, standings }));
  }

  /**
   * What a commit holds never changes, so the judged folders of a commit are kept for the next
   * requests; a new commit is a new key, and the four latest are kept. A Workflow the list does
   * not hold is read by itself and not kept.
   */
  private async readMemoised(commit: string, name: string | undefined): Promise<Read> {
    let all = this.memo.get(commit);
    if (all) {
      this.memo.delete(commit);
    } else if (name === undefined) {
      const read = await this.readDefinitions(commit, undefined);
      if (read.status !== 'read') return read;
      all = read;
    }
    if (all) {
      this.memo.set(commit, all);
      while (this.memo.size > MEMOISED_COMMITS) this.memo.delete(this.memo.keys().next().value!);
    }
    if (name === undefined) return all as ReadOk;
    const found = all?.folders.filter((folder) => folder.name === name) ?? [];
    if (all && (found.length > 0 || !all.truncated)) {
      return { status: 'read', folders: found, truncated: all.truncated };
    }
    return this.readDefinitions(commit, name);
  }

  private async readDefinitions(commit: string, name: string | undefined): Promise<Read> {
    const tree = await this.definitions.listTree(commit, { directory: WORKFLOWS_DIRECTORY });
    if (tree.status !== 'listed') return tree;

    let folders = findWorkflowFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    folders.sort(byName);
    let truncated = tree.truncated || (name === undefined && folders.length > MAX_LISTED_WORKFLOWS);
    const candidates =
      name === undefined
        ? folders.slice(0, MAX_LISTED_WORKFLOWS)
        : folders.filter((folder) => folder.name === name);

    // Folders are taken in name order while the paths and bytes to read stay within the budget.
    const chosen: { folder: WorkflowFolder; wanted: AgentEntry[] }[] = [];
    let paths = 0;
    let bytes = 0;
    for (const folder of candidates) {
      const wanted = toRead(folder);
      const size = wanted.reduce((sum, item) => sum + item.size, 0);
      if (paths + wanted.length > MAX_READ_PATHS || bytes + size > MAX_READ_BYTES) {
        truncated = true;
        break;
      }
      paths += wanted.length;
      bytes += size;
      chosen.push({ folder, wanted });
    }

    const toFetch = chosen.flatMap(({ folder, wanted }) =>
      wanted.map((item) => `${WORKFLOWS_DIRECTORY}/${folder.name}/${item.path}`),
    );
    const contents = new Map<string, DefinitionsFileRead>();
    if (toFetch.length > 0) {
      const files = await this.definitions.readFiles(commit, toFetch, MAX_FILE_BYTES);
      if (files.status !== 'read') return files;
      for (const file of files.files) contents.set(file.path, file);
    }
    return {
      status: 'read',
      folders: chosen.map(({ folder, wanted }) => judgeFolder(folder, wanted, contents)),
      truncated,
    };
  }
}

const filesOf = (folder: WorkflowFolder) => folder.entries.filter((item) => item.kind === 'file');

/** A folder the validation refuses by the declared count and sizes alone. */
function isRefusedBySize(folder: WorkflowFolder): boolean {
  const files = filesOf(folder);
  return (
    files.length > MAX_FILES ||
    files.some((item) => item.size > MAX_FILE_BYTES) ||
    files.reduce((sum, item) => sum + item.size, 0) > MAX_FOLDER_BYTES
  );
}

/** The entry file, none for a folder refused by size. */
function toRead(folder: WorkflowFolder): AgentEntry[] {
  if (isRefusedBySize(folder)) return [];
  return filesOf(folder).filter((item) => item.path === WORKFLOW_ENTRY_FILE);
}

function judgeFolder(
  folder: WorkflowFolder,
  wanted: AgentEntry[],
  contents: Map<string, DefinitionsFileRead>,
): JudgedFolder {
  const result = validateWorkflowFolder(
    folder.name,
    folder.entries.map((item) => {
      const read = contents.get(`${WORKFLOWS_DIRECTORY}/${folder.name}/${item.path}`);
      return read?.status === 'found' && !read.binary ? { ...item, content: read.text } : item;
    }),
  );
  if (result.ok) return { name: folder.name, result };
  // A folder refused by its declared sizes was not read: it has no "cannot be read" reasons.
  const unread = wanted.length === 0 && isRefusedBySize(folder);
  return {
    name: folder.name,
    result: {
      ok: false,
      problems: unread
        ? result.problems.filter((item) => item.code !== 'entry_unreadable')
        : result.problems,
    },
  };
}
