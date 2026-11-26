import {
  findSkillFolders,
  MARKDOWN_FILE,
  type AgentEntry,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  type SkillFolder,
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
} from '../../projects/contracts/index.js';

/** Most skill folders listed; the rest are cut and the result says so. */
export const MAX_LISTED_SKILLS = 200;

export interface SkillsReadInput {
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

export interface SkillsRead {
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

/**
 * Most files read for one list, and their declared bytes. Each file is one Git process inside the
 * 10-second read budget of the Clone; 500 leave a wide margin, and 16 MiB keeps the buffered text
 * small. A folder reads at most 100 files and 5 MiB, so the first folder always fits.
 */
export const MAX_READ_PATHS = 500;
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** Commits whose judged list is kept. */
const MEMOISED_COMMITS = 4;

/**
 * Unique skill names per commit that may be read by themselves after the list was cut. One read of
 * a folder is at most 5 MiB and 100 files, so 200 names stay inside MAX_READ_PATHS for the usual
 * one-file skill and are read in one go; the rest fail closed, the same on every request.
 */
export const MAX_ON_DEMAND_SKILLS = 200;

export interface SkillStandings {
  /** A skill that exists, whether it is valid; a name that does not exist is absent. */
  standings: Map<string, { valid: boolean }>;
  /** False only after a transient read failure: the answer must not be kept for the commit. */
  settled: boolean;
}

/** What a named skill turned out to be at a commit; a skill that cannot be judged is invalid. */
type Outcome = 'missing' | { valid: boolean };

const unjudged = (names: readonly string[]): SkillStandings => ({
  standings: new Map(names.map((name) => [name, { valid: false }])),
  settled: false,
});

type ReadOk = { status: 'read'; skills: SkillView[]; truncated: boolean };
type Read = ReadOk | { status: DefinitionsUnavailable };

/**
 * The skill folders found in the definitions Repository's Clone at the last fetched commit,
 * judged by the shared validation only; the Draft is never read. Shared by the skills use case
 * and by the agents, which judge the skills they name.
 */
@Injectable()
export class SkillsReader {
  private readonly memo = new Map<string, ReadOk>();
  private readonly outcomes = new Map<string, Map<string, Outcome>>();

  constructor(@Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles) {}

  async read(input: SkillsReadInput = {}): Promise<SkillsRead> {
    const snapshot = await this.definitions.snapshot();
    if (!snapshot) return { commit: null, repository: null, truncated: false, skills: [] };
    const stateNote = snapshot.state === 'ready' ? null : STATE_NOTES[snapshot.state];
    const unread = (note: string): SkillsRead => ({
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
   * Whether each named skill exists and is valid; a missing one is absent from the result. One that
   * cannot be judged counts as invalid, not missing. What a name turned out to be is kept per
   * commit; only a transient read failure leaves `settled` false, so that nothing is kept.
   */
  async standings(commit: string, names: readonly string[]): Promise<SkillStandings> {
    const listed = await this.readMemoised(commit, undefined);
    if (listed.status !== 'read') return unjudged(names);
    const known = new Map(listed.skills.map((skill) => [skill.name, skill.valid]));
    const kept = this.outcomesOf(commit);
    const unique = [...new Set(names)].sort();
    const pending = listed.truncated
      ? unique.filter((name) => !known.has(name) && !kept.has(name))
      : [];
    const settled = pending.length === 0 || (await this.resolve(commit, pending, kept));
    const standings = new Map<string, { valid: boolean }>();
    for (const name of unique) {
      const valid = known.get(name);
      const outcome = valid === undefined ? kept.get(name) : { valid };
      if (outcome === undefined) {
        // Not kept after a failed read: it counts as invalid, never as missing.
        if (listed.truncated) standings.set(name, { valid: false });
      } else if (outcome !== 'missing') standings.set(name, outcome);
    }
    return { standings, settled };
  }

  private outcomesOf(commit: string): Map<string, Outcome> {
    let kept = this.outcomes.get(commit);
    if (!kept) {
      kept = new Map();
      this.outcomes.set(commit, kept);
      while (this.outcomes.size > MEMOISED_COMMITS) {
        this.outcomes.delete(this.outcomes.keys().next().value!);
      }
    }
    return kept;
  }

  /** Reads the named folders beyond the cut list in one listing and one read; false on failure. */
  private async resolve(
    commit: string,
    names: string[],
    kept: Map<string, Outcome>,
  ): Promise<boolean> {
    const tree = await this.definitions.listTree(commit, { directory: SKILLS_DIRECTORY });
    if (tree.status !== 'listed') return false;
    let folders = findSkillFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    const byName = new Map(folders.map((folder) => [folder.name, folder]));

    const decided = new Map<string, Outcome>();
    const chosen: { folder: SkillFolder; wanted: AgentEntry[] }[] = [];
    let paths = 0;
    let bytes = 0;
    let slots = MAX_ON_DEMAND_SKILLS - kept.size;
    for (const name of names) {
      const folder = byName.get(name);
      slots -= 1;
      if (slots < 0) decided.set(name, { valid: false });
      else if (!folder) decided.set(name, tree.truncated ? { valid: false } : 'missing');
      else {
        const wanted = toRead(folder);
        const size = wanted.reduce((sum, item) => sum + item.size, 0);
        if (paths + wanted.length > MAX_READ_PATHS || bytes + size > MAX_READ_BYTES) {
          decided.set(name, { valid: false });
        } else {
          paths += wanted.length;
          bytes += size;
          chosen.push({ folder, wanted });
        }
      }
    }

    const contents = new Map<string, DefinitionsFileRead>();
    const toFetch = chosen.flatMap(({ folder, wanted }) =>
      wanted.map((item) => `${SKILLS_DIRECTORY}/${folder.name}/${item.path}`),
    );
    if (toFetch.length > 0) {
      const files = await this.definitions.readFiles(commit, toFetch, MAX_FILE_BYTES);
      if (files.status !== 'read') return false;
      for (const file of files.files) contents.set(file.path, file);
    }
    for (const { folder, wanted } of chosen) {
      decided.set(folder.name, { valid: judgeFolder(folder, wanted, contents).valid });
    }
    for (const [name, outcome] of decided) kept.set(name, outcome);
    return true;
  }

  /**
   * What a commit holds never changes, so the judged list of a commit is kept for the next
   * requests; a new commit is a new key. The four latest commits asked for are kept. A skill
   * the list does not hold is read by itself and not kept.
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
    const found = all?.skills.filter((skill) => skill.name === name) ?? [];
    if (all && (found.length > 0 || !all.truncated)) {
      return { status: 'read', skills: found, truncated: all.truncated };
    }
    return this.readDefinitions(commit, name);
  }

  private async readDefinitions(commit: string, name: string | undefined): Promise<Read> {
    const tree = await this.definitions.listTree(commit, { directory: SKILLS_DIRECTORY });
    if (tree.status !== 'listed') return tree;

    let folders = findSkillFolders(tree.entries);
    // A cut listing ends inside its last folder: that one may be partial, so it is not judged.
    if (tree.truncated) folders = folders.slice(0, -1);
    folders.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let truncated = tree.truncated || (name === undefined && folders.length > MAX_LISTED_SKILLS);
    const candidates =
      name === undefined
        ? folders.slice(0, MAX_LISTED_SKILLS)
        : folders.filter((folder) => folder.name === name);

    // Folders are taken in name order while the paths and bytes to read stay within the budget.
    const chosen: { folder: SkillFolder; wanted: AgentEntry[] }[] = [];
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
      wanted.map((item) => `${SKILLS_DIRECTORY}/${folder.name}/${item.path}`),
    );
    const contents = new Map<string, DefinitionsFileRead>();
    if (toFetch.length > 0) {
      const files = await this.definitions.readFiles(commit, toFetch, MAX_FILE_BYTES);
      if (files.status !== 'read') return files;
      for (const file of files.files) contents.set(file.path, file);
    }

    const skills = chosen.map(({ folder, wanted }) => judgeFolder(folder, wanted, contents));
    return { status: 'read', skills, truncated };
  }
}

/** The view of one skill folder, judged from the files read of it. */
export function judgeFolder(
  folder: SkillFolder,
  wanted: AgentEntry[],
  contents: Map<string, DefinitionsFileRead>,
): SkillView {
  const pathOf = (path: string) => `${SKILLS_DIRECTORY}/${folder.name}/${path}`;
  const judged = validateSkillFolder(
    folder.name,
    folder.entries.map((item) => {
      const read = contents.get(pathOf(item.path));
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
  // A folder refused by its declared sizes was not read: it has no "cannot be read" reasons.
  const unread = wanted.length === 0 && isRefusedBySize(folder);
  return {
    name: folder.name,
    description: null,
    valid: false,
    problems: unread
      ? judged.problems.filter((item) => item.code !== 'entry_unreadable')
      : judged.problems,
    instructions: '',
    files: folder.entries
      .filter((item) => item.kind === 'file')
      .map(({ path, size }) => ({ path, size })),
  };
}

const filesOf = (folder: SkillFolder) => folder.entries.filter((item) => item.kind === 'file');

/** A folder the validation refuses by the declared count and sizes alone. */
function isRefusedBySize(folder: SkillFolder): boolean {
  const files = filesOf(folder);
  return (
    files.length > MAX_FILES ||
    files.some((item) => item.size > MAX_FILE_BYTES) ||
    files.reduce((sum, item) => sum + item.size, 0) > MAX_FOLDER_BYTES
  );
}

/** The entry file and every Markdown file (read for shell lines), none for a refused folder. */
export function toRead(folder: SkillFolder): AgentEntry[] {
  if (isRefusedBySize(folder)) return [];
  return filesOf(folder).filter(
    (item) => item.path === SKILL_ENTRY_FILE || MARKDOWN_FILE.test(item.path),
  );
}
