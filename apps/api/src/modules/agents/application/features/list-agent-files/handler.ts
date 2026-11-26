import {
  AGENTS_DIRECTORY,
  findAgentFolders,
  findSkillFolders,
  SKILLS_DIRECTORY,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_FILES,
  type DefinitionsFiles,
  type DefinitionsUnavailable,
  type RepositoryState,
} from '../../../../projects/contracts/index.js';

/** What a Repository state that is not `ready` means for what is read from its last commit. */
const STATE_NOTES: Record<Exclude<RepositoryState, 'ready'>, string> = {
  awaiting_key: 'The Repository is waiting for its Deploy key to be added to the Git host.',
  awaiting_host_key: 'The Repository is waiting for the key of the Git host to be confirmed.',
  connecting: 'The Repository is being connected.',
  fetching: 'A fetch of the Repository is running.',
  failed: 'The last operation on the Repository failed.',
  disconnecting: 'The Repository is being disconnected.',
};

/** Why the Clone could not be read. */
const UNAVAILABLE_NOTES: Record<DefinitionsUnavailable, string> = {
  repository_not_ready: 'The Repository has no Clone to read agents from.',
  unsupported_platform: 'Studio can read the definitions Repository only on Linux.',
  commit_missing: 'The Clone of the Repository does not hold that commit.',
  failed: 'The Clone of the Repository could not be read.',
};

/** Most entries listed; a larger tree is cut and the result says so. */
export const AGENT_FILES_MAX_ENTRIES = 2000;

export interface AgentFileEntry {
  path: string;
  kind: 'file' | 'symlink' | 'submodule';
  /** Size in bytes; 0 for anything that is not a regular file. */
  size: number;
  /** The agent folder the entry belongs to, or `null` for any other part of the Repository. */
  agent: string | null;
  /** The skill folder the entry belongs to, or `null` for any other part of the Repository. */
  skill: string | null;
}

export interface ListAgentFilesResult {
  /** The commit the tree was read at; `null` when none was read. */
  commit: string | null;
  /** `null` when no definitions Repository is connected. */
  repository: { state: RepositoryState; note: string | null } | null;
  truncated: boolean;
  entries: AgentFileEntry[];
}

/**
 * The whole definitions Repository as a tree, at its last fetched commit, from the Clone's object
 * store. It names which entries belong to an agent or a skill folder and judges nothing; the
 * validation of an agent is the agent list, that of a skill the skill list.
 */
@Injectable()
export class ListAgentFilesHandler {
  constructor(@Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles) {}

  async execute(): Promise<ListAgentFilesResult> {
    const snapshot = await this.definitions.snapshot();
    if (!snapshot) return { commit: null, repository: null, truncated: false, entries: [] };
    const stateNote = snapshot.state === 'ready' ? null : STATE_NOTES[snapshot.state];
    const unread = (note: string): ListAgentFilesResult => ({
      commit: null,
      repository: { state: snapshot.state, note },
      truncated: false,
      entries: [],
    });
    if (snapshot.commit === null) {
      return unread(
        `${stateNote ?? UNAVAILABLE_NOTES.repository_not_ready} No files are read from it yet.`,
      );
    }
    const tree = await this.definitions.listTree(snapshot.commit, { whole: true });
    if (tree.status !== 'listed') return unread(UNAVAILABLE_NOTES[tree.status]);

    const folderOf =
      (directory: string, names: Set<string>) =>
      (path: string): string | null => {
        const prefix = `${directory}/`;
        if (!path.startsWith(prefix)) return null;
        const name = path.slice(prefix.length).split('/')[0]!;
        return names.has(name) ? name : null;
      };
    const agentOf = folderOf(
      AGENTS_DIRECTORY,
      new Set(findAgentFolders(tree.entries).map((folder) => folder.name)),
    );
    const skillOf = folderOf(
      SKILLS_DIRECTORY,
      new Set(findSkillFolders(tree.entries).map((folder) => folder.name)),
    );
    const entries = tree.entries.flatMap((entry): AgentFileEntry[] =>
      entry.kind === 'other'
        ? []
        : [
            {
              path: entry.path,
              kind: entry.kind,
              size: entry.size,
              agent: agentOf(entry.path),
              skill: skillOf(entry.path),
            },
          ],
    );
    return {
      commit: snapshot.commit,
      repository: {
        state: snapshot.state,
        note: stateNote ? `${stateNote} This is the tree at the last fetched commit.` : null,
      },
      truncated: tree.truncated || entries.length > AGENT_FILES_MAX_ENTRIES,
      entries: entries.slice(0, AGENT_FILES_MAX_ENTRIES),
    };
  }
}
