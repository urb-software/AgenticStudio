import {
  AGENT_ENTRY_FILE,
  agentSkillNames,
  AGENTS_DIRECTORY,
  checkAgentSkills,
  findAgentFolders,
  findSkillFolders,
  MAX_FILE_BYTES,
  type AgentEntry,
  type ProblemCode,
  type SkillProblemCode,
  SKILLS_DIRECTORY,
  validateAgentFolder,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  DEFINITIONS_FILES,
  type DefinitionsFileRead,
  type DefinitionsFiles,
} from '../../projects/contracts/index.js';
import type { AgentDraft } from '../domain/entities/agent-draft.js';
import {
  AGENT_DRAFT_REPOSITORY,
  type AgentDraftRepository,
} from '../domain/repositories/agent-draft-repository.js';
import type { AgentDraftChange } from '../domain/value-objects/agent-draft-file.js';
import { judgeFolder, MAX_READ_BYTES, MAX_READ_PATHS, toRead } from './skills-reader.js';

export interface AgentDraftProblem {
  /** The agent folder the problem is in. */
  agent: string;
  code: ProblemCode;
  /** The file or folder in the Repository, with `/` separators. */
  path: string;
  key: string | null;
  message: string;
}

export interface AgentDraftSkillProblem {
  /** The skill folder the problem is in. */
  skill: string;
  code: SkillProblemCode;
  /** The file or folder in the Repository, with `/` separators. */
  path: string;
  key: string | null;
  message: string;
}

/** What the Draft's state makes of the skills it touches and of the agents it touches or that name them. */
export interface DraftJudgement {
  agents: AgentDraftProblem[];
  skills: AgentDraftSkillProblem[];
}

// A BOM is kept, as Git's own text read keeps it.
const LENIENT_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const entryPathOf = (agent: string) => `${AGENTS_DIRECTORY}/${agent}/${AGENT_ENTRY_FILE}`;

/** The folder a Draft path is in below `directory`, or `null`. */
const folderOf = (directory: string, path: string): string[] => {
  const [top, name] = path.split('/');
  return top === directory && name ? [name] : [];
};

const placeOf = (directory: string, folder: string, path: string) =>
  path === '' ? `${directory}/${folder}` : `${directory}/${folder}/${path}`;

/**
 * Judges the Draft over its base tree: the skills it touches, the agents it touches and those
 * naming a touched skill, against the skills as the Draft leaves them. `null` means nothing was
 * judged (the Clone could not be read whole); a publish must refuse it, it is never "no problem".
 */
export async function judgeDraftState(
  definitions: DefinitionsFiles,
  drafts: AgentDraftRepository,
  draft: AgentDraft,
  baseCommit: string,
): Promise<DraftJudgement | null> {
  const tree = await definitions.listTree(baseCommit, { whole: true });
  if (tree.status !== 'listed' || tree.truncated) return null;

  const changed = new Map(draft.files.map((file) => [file.path, file]));
  const entries: AgentEntry[] = [
    ...tree.entries
      .filter((entry) => !changed.has(entry.path))
      .map(({ path, kind, size }) => ({ path, kind, size })),
    ...draft.files
      .filter((file) => !file.isDeleted)
      .map((file) => ({ path: file.path, kind: 'file', size: file.size })),
  ];
  const touched = (directory: string) =>
    new Set(draft.files.flatMap((file) => folderOf(directory, file.path)));
  const touchedAgents = touched(AGENTS_DIRECTORY);
  const touchedSkills = touched(SKILLS_DIRECTORY);

  /** The text of each path as the Draft has it; a path that is not UTF-8 text is left out. */
  const textsOf = async (paths: string[]): Promise<Map<string, string> | null> => {
    const texts = new Map<string, string>();
    const stored = await drafts.findContents(paths.filter((path) => changed.has(path)));
    for (const [path, bytes] of stored) texts.set(path, LENIENT_UTF8.decode(bytes));
    const unchanged = paths.filter((path) => !changed.has(path));
    if (unchanged.length > 0) {
      const read = await definitions.readFiles(baseCommit, unchanged, MAX_FILE_BYTES);
      if (read.status !== 'read') return null;
      for (const file of read.files) {
        if (file.status === 'found' && !file.binary) texts.set(file.path, file.text);
      }
    }
    return texts;
  };

  // With a skill touched every agent is read: any of them may name it.
  const agentFolders = findAgentFolders(entries)
    .filter((folder) => touchedAgents.has(folder.name) || touchedSkills.size > 0)
    .sort(byName);
  const agentEntries = agentFolders
    .filter((folder) =>
      folder.entries.some((entry) => entry.path === AGENT_ENTRY_FILE && entry.kind === 'file'),
    )
    .map((folder) => entryPathOf(folder.name));
  if (agentEntries.length > MAX_READ_PATHS) return null;
  const agentTexts = await textsOf(agentEntries);
  if (agentTexts === null) return null;

  const judgedAgents = agentFolders.flatMap((folder) => {
    const text = agentTexts.get(entryPathOf(folder.name));
    const judged = validateAgentFolder(
      folder.name,
      folder.entries.map((entry) =>
        entry.path === AGENT_ENTRY_FILE && text !== undefined ? { ...entry, content: text } : entry,
      ),
    );
    let named: string[] = [];
    if (judged.ok) named = judged.definition.skills;
    else if (text !== undefined) named = agentSkillNames(text);
    const relevant = touchedAgents.has(folder.name) || named.some((n) => touchedSkills.has(n));
    return relevant ? [{ folder, judged }] : [];
  });

  // Only the skills that matter are read: the touched ones and those the judged agents name.
  const wanted = new Set(touchedSkills);
  for (const { judged } of judgedAgents) {
    if (judged.ok) for (const name of judged.definition.skills) wanted.add(name);
  }
  const toFetch = findSkillFolders(entries)
    .filter((folder) => wanted.has(folder.name))
    .sort(byName)
    .map((folder) => ({ folder, files: toRead(folder) }));
  const paths = toFetch.flatMap(({ folder, files }) =>
    files.map((file) => `${SKILLS_DIRECTORY}/${folder.name}/${file.path}`),
  );
  const bytes = toFetch.reduce(
    (sum, { files }) => sum + files.reduce((total, file) => total + file.size, 0),
    0,
  );
  if (paths.length > MAX_READ_PATHS || bytes > MAX_READ_BYTES) return null;
  const skillTexts = await textsOf(paths);
  if (skillTexts === null) return null;
  const contents = new Map<string, DefinitionsFileRead>();
  for (const [path, text] of skillTexts) {
    contents.set(path, { path, status: 'found', text, size: text.length, binary: false });
  }

  const standings = new Map<string, { valid: boolean }>();
  const skills: AgentDraftSkillProblem[] = [];
  for (const { folder, files } of toFetch) {
    const view = judgeFolder(folder, files, contents);
    standings.set(folder.name, { valid: view.valid });
    if (!touchedSkills.has(folder.name)) continue;
    for (const problem of view.problems) {
      skills.push({
        skill: folder.name,
        code: problem.code,
        path: placeOf(SKILLS_DIRECTORY, folder.name, problem.path),
        key: problem.key ?? null,
        message: problem.message,
      });
    }
  }

  const agents = judgedAgents.flatMap(({ folder, judged }) => {
    const problems = judged.ok ? checkAgentSkills(judged.definition, standings) : judged.problems;
    return problems.map((problem): AgentDraftProblem => ({
      agent: folder.name,
      code: problem.code,
      path: placeOf(AGENTS_DIRECTORY, folder.name, problem.path),
      key: problem.key ?? null,
      message: problem.message,
    }));
  });
  return { agents, skills };
}

/** The Draft as the operator sees it: its changes, the problems they would make, and what moved upstream. */
export interface AgentDraftView {
  baseCommit: string | null;
  /** The commit the Repository holds now; `null` when none. */
  currentCommit: string | null;
  version: number;
  files: {
    path: string;
    change: AgentDraftChange;
    size: number;
    movedFrom: string | null;
    /** The skill folder the path is in; `null` for any other path. */
    skill: string | null;
  }[];
  /** The agents the Draft touches, or that name a skill it touches, judged on the Draft's state. */
  problems: AgentDraftProblem[];
  /** The skills the Draft touches, judged on the Draft's state. */
  skillProblems: AgentDraftSkillProblem[];
  /** Paths of the Draft whose content differs between the base commit and the current one. */
  movedUpstream: string[];
}

/** How often a write retries its whole load, change and save when another write got in first. */
export const DRAFT_WRITE_ATTEMPTS = 3;

/** The skill a Draft path is in (`skills/<name>/...`), or `null`. */
const skillOf = (path: string): string | null => {
  const [top, name, ...rest] = path.split('/');
  return top === SKILLS_DIRECTORY && name && rest.length > 0 ? name : null;
};

/**
 * Shows the Draft whole: its problems (see `judgeDraftState`) and its paths that changed upstream
 * by blob id. When the Clone cannot be read, the problems and `movedUpstream` are empty and the
 * Draft itself is still shown.
 */
@Injectable()
export class AgentDraftReader {
  constructor(
    @Inject(DEFINITIONS_FILES) private readonly definitions: DefinitionsFiles,
    @Inject(AGENT_DRAFT_REPOSITORY) private readonly drafts: AgentDraftRepository,
  ) {}

  async read(draft: AgentDraft): Promise<AgentDraftView> {
    const currentCommit = (await this.definitions.snapshot())?.commit ?? null;
    const baseCommit = draft.baseCommit;
    const files = draft.files.map(({ path, change, size, movedFrom }) => ({
      path,
      change,
      size,
      movedFrom,
      skill: skillOf(path),
    }));
    const view = {
      baseCommit,
      currentCommit,
      version: draft.version,
      files,
      problems: [] as AgentDraftProblem[],
      skillProblems: [] as AgentDraftSkillProblem[],
      movedUpstream: [] as string[],
    };
    if (baseCommit === null || files.length === 0) return view;
    const [judged, movedUpstream] = await Promise.all([
      judgeDraftState(this.definitions, this.drafts, draft, baseCommit),
      this.movedUpstream(draft, baseCommit, currentCommit),
    ]);
    return {
      ...view,
      problems: judged?.agents ?? [],
      skillProblems: judged?.skills ?? [],
      movedUpstream,
    };
  }

  /**
   * The problems of the Draft's skills and agents, or `null` when the Clone could not be read, so
   * that nothing was judged. A publish must refuse `null`: it never means "no problem".
   */
  judge(draft: AgentDraft): Promise<DraftJudgement | null> {
    if (draft.baseCommit === null) return Promise.resolve(null);
    return judgeDraftState(this.definitions, this.drafts, draft, draft.baseCommit);
  }

  private async movedUpstream(
    draft: AgentDraft,
    baseCommit: string,
    currentCommit: string | null,
  ): Promise<string[]> {
    if (currentCommit === null || currentCommit === baseCommit) return [];
    const paths = draft.files.map((file) => file.path);
    const [atBase, atCurrent] = await Promise.all([
      this.definitions.blobIds(baseCommit, paths),
      this.definitions.blobIds(currentCommit, paths),
    ]);
    if (atBase.status !== 'read' || atCurrent.status !== 'read') return [];
    // Equal content with another Git mode (the executable bit) is a change too.
    const current = new Map(atCurrent.blobs.map((entry) => [entry.path, entry]));
    return atBase.blobs
      .filter((entry) => {
        const now = current.get(entry.path);
        return (
          (now?.blob ?? null) !== entry.blob || (now?.executable ?? false) !== entry.executable
        );
      })
      .map((entry) => entry.path)
      .sort();
  }
}
