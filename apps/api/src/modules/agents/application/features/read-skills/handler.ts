import {
  findSkillFolders,
  MARKDOWN_FILE,
  MAX_FILE_BYTES,
  MAX_FILES,
  type Problem,
  SKILL_ENTRY_FILE,
  type SkillProblemCode,
  SKILLS_DIRECTORY,
  validateSkillFolder,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_FILES,
  type DefinitionsFileRead,
  type DefinitionsFiles,
  type DefinitionsUnavailable,
  type RepositoryState,
} from '../../../../projects/contracts/index.js';

/** Most skill folders listed; the rest are cut and the result says so. */
export const MAX_LISTED_SKILLS = 200;

export interface ReadSkillsInput {
  /** Reads this skill only, wherever it sits among the folders. */
  name?: string;
}

export interface SkillView {
  name: string;
  /** `null` for a skill that is not valid. */
  description: string | null;
  valid: boolean;
  problems: Problem<SkillProblemCode>[];
  /** The Markdown after the front matter; empty for a skill that is not valid. */
  instructions: string;
  files: { path: string; size: number }[];
}

export interface ReadSkillsResult {
  /** The commit the skills were read at; `null` when none were read. */
  commit: string | null;
  /** `null` when no definitions Repository is connected. */
  repository: { state: RepositoryState; note: string | null } | null;
  truncated: boolean;
  skills: SkillView[];
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
  repository_not_ready: 'The Repository has no Clone to read skills from.',
  unsupported_platform: 'Studio can read the definitions Repository only on Linux.',
  commit_missing: 'The Clone of the Repository does not hold that commit.',
  failed: 'The Clone of the Repository could not be read.',
};

/** Commits whose judged list is kept. */
const MEMOISED_COMMITS = 4;

type ReadOk = { status: 'read'; skills: SkillView[]; truncated: boolean };
type Read = ReadOk | { status: DefinitionsUnavailable };

/**
 * The skill folders found in the definitions Repository's Clone at the last fetched commit,
 * judged by the shared validation only. The list and the single skill are one use case; the
 * Draft is never read.
 */
@Injectable()
export class ReadSkillsHandler {
  private readonly memo = new Map<string, ReadOk>();

  constructor(@Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles) {}

  async execute(input: ReadSkillsInput = {}): Promise<ReadSkillsResult> {
    const snapshot = await this.definitions.snapshot();
    if (!snapshot) return { commit: null, repository: null, truncated: false, skills: [] };
    const stateNote = snapshot.state === 'ready' ? null : STATE_NOTES[snapshot.state];
    const unread = (note: string): ReadSkillsResult => ({
      commit: null,
      repository: { state: snapshot.state, note },
      truncated: false,
      skills: [],
    });
    if (snapshot.commit === null) {
      return unread(
        `${stateNote ?? UNAVAILABLE_NOTES.repository_not_ready} No skills are read from it yet.`,
      );
    }
    const read = await this.readMemoised(snapshot.commit, input.name);
    if (read.status !== 'read') return unread(UNAVAILABLE_NOTES[read.status]);
    return {
      commit: snapshot.commit,
      repository: {
        state: snapshot.state,
        note: stateNote ? `${stateNote} These are the skills at the last fetched commit.` : null,
      },
      truncated: read.truncated,
      skills: read.skills,
    };
  }

  /**
   * What a commit holds never changes, so the judged list of a commit is kept for the next
   * requests; a new commit is a new key. The four latest commits asked for are kept.
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
    const found = all.skills.filter((skill) => skill.name === name);
    // A folder beyond the listed ones is read by itself.
    if (found.length === 0 && all.truncated) return this.readDefinitions(commit, name);
    return { status: 'read', skills: found, truncated: all.truncated };
  }

  private async readDefinitions(commit: string, name: string | undefined): Promise<Read> {
    const tree = await this.definitions.listTree(commit, { directory: SKILLS_DIRECTORY });
    if (tree.status !== 'listed') return tree;

    let folders = findSkillFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    const truncated = tree.truncated || folders.length > MAX_LISTED_SKILLS;
    const chosen = folders
      .filter((folder) => name === undefined || folder.name === name)
      .slice(0, MAX_LISTED_SKILLS);

    // The text judged is the entry file and every Markdown file (read for shell lines).
    const pathOf = (folder: string, path: string) => `${SKILLS_DIRECTORY}/${folder}/${path}`;
    const wanted = chosen.flatMap((folder) =>
      folder.entries.filter((item) => item.kind === 'file').length > MAX_FILES
        ? []
        : folder.entries
            .filter(
              (item) =>
                item.kind === 'file' &&
                (item.path === SKILL_ENTRY_FILE || MARKDOWN_FILE.test(item.path)),
            )
            .map((item) => pathOf(folder.name, item.path)),
    );
    const contents = new Map<string, DefinitionsFileRead>();
    if (wanted.length > 0) {
      const files = await this.definitions.readFiles(commit, wanted, MAX_FILE_BYTES);
      if (files.status !== 'read') return files;
      for (const file of files.files) contents.set(file.path, file);
    }

    const skills = chosen.map((folder): SkillView => {
      const judged = validateSkillFolder(
        folder.name,
        folder.entries.map((item) => {
          const read = contents.get(pathOf(folder.name, item.path));
          return read?.status === 'found' && !read.binary ? { ...item, content: read.text } : item;
        }),
      );
      if (judged.ok) {
        const { definition } = judged;
        return {
          name: definition.name,
          description: definition.description,
          valid: true,
          problems: [],
          instructions: definition.instructions,
          files: definition.files,
        };
      }
      return {
        name: folder.name,
        description: null,
        valid: false,
        problems: judged.problems,
        instructions: '',
        files: folder.entries
          .filter((item) => item.kind === 'file')
          .map(({ path, size }) => ({ path, size })),
      };
    });
    return { status: 'read', skills, truncated };
  }
}
