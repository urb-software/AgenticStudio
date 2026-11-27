import {
  AGENT_ENTRY_FILE,
  agentSkillNames,
  AGENTS_DIRECTORY,
  checkAgentSkills,
  checkWorkflowAgents,
  findAgentFolders,
  findSkillFolders,
  findWorkflowFolders,
  MAX_FILE_BYTES,
  type AgentEntry,
  type ProblemCode,
  type SkillProblemCode,
  SKILLS_DIRECTORY,
  validateAgentFolder,
  validateWorkflowFolder,
  WORKFLOW_ENTRY_FILE,
  type WorkflowProblemCode,
  workflowAgentNames,
  WORKFLOWS_DIRECTORY,
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

export interface AgentDraftWorkflowProblem {
  /** The workflow folder the problem is in. */
  workflow: string;
  code: WorkflowProblemCode;
  /** The file or folder in the Repository, with `/` separators. */
  path: string;
  key: string | null;
  message: string;
}

/**
 * What the Draft's state makes of the skills and workflows it touches, of the agents it touches or
 * that name a touched skill, and of the workflows that name an agent whose standing may change.
 */
export type DraftJudgement =
  | {
      judged: true;
      agents: AgentDraftProblem[];
      skills: AgentDraftSkillProblem[];
      workflows: AgentDraftWorkflowProblem[];
    }
  | { judged: false; reason: NotJudgedReason };

/** Why a Draft could not be judged: the Clone could not be read, or the judgement was over its limits. */
export type NotJudgedReason = 'clone_unreadable' | 'over_limits';

/** Per base commit, the names each folder's entry file lists; a base commit never changes. */
export type BaseNames = Map<string, Map<string, string[]>>;

/** What the judgement keeps between runs: the skills each agent names, the agents each workflow names. */
export interface BaseNameMemos {
  agentSkills: BaseNames;
  workflowAgents: BaseNames;
}

/** Base commits whose agents' skill names are kept. */
const MEMOISED_BASES = 4;

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The text of stored bytes as the Clone read gives it: NUL or invalid UTF-8 is no text. */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    const text = STRICT_UTF8.decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

const entryPathOf = (agent: string) => `${AGENTS_DIRECTORY}/${agent}/${AGENT_ENTRY_FILE}`;
const workflowEntryPathOf = (workflow: string) =>
  `${WORKFLOWS_DIRECTORY}/${workflow}/${WORKFLOW_ENTRY_FILE}`;

/** The folder a Draft path is in below `directory`, or `null`. */
const folderOf = (directory: string, path: string): string[] => {
  const [top, name] = path.split('/');
  return top === directory && name ? [name] : [];
};

const placeOf = (directory: string, folder: string, path: string) =>
  path === '' ? `${directory}/${folder}` : `${directory}/${folder}/${path}`;

const NOT_READ: DraftJudgement = { judged: false, reason: 'clone_unreadable' };
const OVER_LIMITS: DraftJudgement = { judged: false, reason: 'over_limits' };

/**
 * Judges the Draft over its base tree: the skills it touches, the agents it touches and those
 * naming a touched skill, against the skills as the Draft leaves them. A Draft that could not be
 * judged says why; a publish must refuse it, it is never "no problem".
 */
export async function judgeDraftState(
  definitions: DefinitionsFiles,
  drafts: AgentDraftRepository,
  draft: AgentDraft,
  baseCommit: string,
  memos: BaseNameMemos,
): Promise<DraftJudgement> {
  const tree = await definitions.listTree(baseCommit, { whole: true });
  if (tree.status !== 'listed' || tree.truncated) return NOT_READ;

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
  const touchedWorkflows = touched(WORKFLOWS_DIRECTORY);

  /** The text of each path as the Draft has it; a path that is not text is left out. */
  const textsOf = async (paths: string[]): Promise<Map<string, string> | null> => {
    const texts = new Map<string, string>();
    if (paths.length === 0) return texts;
    const stored = await drafts.findContents(paths.filter((path) => changed.has(path)));
    for (const [path, bytes] of stored) {
      const text = textOf(bytes);
      if (text !== undefined) texts.set(path, text);
    }
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

  /** The names each base entry file lists, by folder; `null` when the Clone could not be read. */
  const baseNamesOf = async (
    memo: BaseNames,
    directory: string,
    entryFile: string,
    namesOf: (text: string) => string[],
  ): Promise<Map<string, string[]> | null | 'over_limits'> => {
    const kept = memo.get(baseCommit);
    if (kept) return kept;
    const base = tree.entries.filter((entry) => {
      const [top, folder, file, ...rest] = entry.path.split('/');
      return (
        entry.kind === 'file' &&
        top === directory &&
        !!folder &&
        file === entryFile &&
        rest.length === 0
      );
    });
    const bytes = base.reduce((sum, entry) => sum + entry.size, 0);
    if (base.length > MAX_READ_PATHS || bytes > MAX_READ_BYTES) return 'over_limits';
    const names = new Map<string, string[]>();
    if (base.length > 0) {
      const read = await definitions.readFiles(
        baseCommit,
        base.map((entry) => entry.path),
        MAX_FILE_BYTES,
      );
      if (read.status !== 'read') return null;
      for (const file of read.files) {
        const folder = file.path.split('/')[1]!;
        const text = file.status === 'found' && !file.binary ? file.text : undefined;
        names.set(folder, text === undefined ? [] : namesOf(text));
      }
    }
    memo.set(baseCommit, names);
    while (memo.size > MEMOISED_BASES) memo.delete(memo.keys().next().value!);
    return names;
  };
  const namingAny = (names: Map<string, string[]>, wanted: Set<string>) =>
    new Set(
      [...names]
        .filter(([, listed]) => listed.some((name) => wanted.has(name)))
        .map(([folder]) => folder),
    );

  // With a skill touched, the agents that name it are found from what the base agents name.
  let naming = new Set<string>();
  if (touchedSkills.size > 0) {
    const names = await baseNamesOf(
      memos.agentSkills,
      AGENTS_DIRECTORY,
      AGENT_ENTRY_FILE,
      agentSkillNames,
    );
    if (names === 'over_limits') return OVER_LIMITS;
    if (names === null) return NOT_READ;
    naming = namingAny(names, touchedSkills);
  }

  // The workflows to judge: those touched, and those naming an agent whose standing may change.
  const changedAgents = new Set([...touchedAgents, ...naming]);
  let namingWorkflows = new Set<string>();
  if (changedAgents.size > 0) {
    const names = await baseNamesOf(
      memos.workflowAgents,
      WORKFLOWS_DIRECTORY,
      WORKFLOW_ENTRY_FILE,
      workflowAgentNames,
    );
    if (names === 'over_limits') return OVER_LIMITS;
    if (names === null) return NOT_READ;
    namingWorkflows = namingAny(names, changedAgents);
  }
  const workflowFolders = findWorkflowFolders(entries)
    .filter((folder) => touchedWorkflows.has(folder.name) || namingWorkflows.has(folder.name))
    .sort(byName);
  const workflowEntries = workflowFolders
    .filter((folder) =>
      folder.entries.some((entry) => entry.path === WORKFLOW_ENTRY_FILE && entry.kind === 'file'),
    )
    .map((folder) => workflowEntryPathOf(folder.name));
  if (workflowEntries.length > MAX_READ_PATHS) return OVER_LIMITS;
  const workflowTexts = await textsOf(workflowEntries);
  if (workflowTexts === null) return NOT_READ;
  const judgedWorkflows = workflowFolders.map((folder) => {
    const text = workflowTexts.get(workflowEntryPathOf(folder.name));
    const judged = validateWorkflowFolder(
      folder.name,
      folder.entries.map((entry) =>
        entry.path === WORKFLOW_ENTRY_FILE && text !== undefined
          ? { ...entry, content: text }
          : entry,
      ),
    );
    return { folder, judged };
  });
  // The agents the judged workflows name are judged too, so that a link to one can be checked.
  const named = new Set<string>();
  for (const { judged } of judgedWorkflows) {
    if (!judged.ok) continue;
    for (const item of judged.definition.sequence) {
      if (item.kind !== 'checkpoint') named.add(item.agent);
    }
  }

  const agentFolders = findAgentFolders(entries)
    .filter(
      (folder) =>
        touchedAgents.has(folder.name) || naming.has(folder.name) || named.has(folder.name),
    )
    .sort(byName);
  const agentEntries = agentFolders
    .filter((folder) =>
      folder.entries.some((entry) => entry.path === AGENT_ENTRY_FILE && entry.kind === 'file'),
    )
    .map((folder) => entryPathOf(folder.name));
  const agentTexts = await textsOf(agentEntries);
  if (agentTexts === null) return NOT_READ;

  const judgedAgents = agentFolders.map((folder) => {
    const text = agentTexts.get(entryPathOf(folder.name));
    const judged = validateAgentFolder(
      folder.name,
      folder.entries.map((entry) =>
        entry.path === AGENT_ENTRY_FILE && text !== undefined ? { ...entry, content: text } : entry,
      ),
    );
    return { folder, judged };
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
  if (paths.length > MAX_READ_PATHS || bytes > MAX_READ_BYTES) return OVER_LIMITS;
  const skillTexts = await textsOf(paths);
  if (skillTexts === null) return NOT_READ;
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

  const checkedAgents = judgedAgents.map(({ folder, judged }) => ({
    folder,
    problems: judged.ok ? checkAgentSkills(judged.definition, standings) : judged.problems,
  }));
  const agentStandings = new Map(
    checkedAgents.map(({ folder, problems }) => [folder.name, { valid: problems.length === 0 }]),
  );
  const agents = checkedAgents.flatMap(({ folder, problems }) => {
    if (!touchedAgents.has(folder.name) && !naming.has(folder.name)) return [];
    return problems.map((problem): AgentDraftProblem => ({
      agent: folder.name,
      code: problem.code,
      path: placeOf(AGENTS_DIRECTORY, folder.name, problem.path),
      key: problem.key ?? null,
      message: problem.message,
    }));
  });
  const workflows = judgedWorkflows.flatMap(({ folder, judged }) => {
    const problems = judged.ok
      ? checkWorkflowAgents(judged.definition, agentStandings)
      : judged.problems;
    return problems.map((problem): AgentDraftWorkflowProblem => ({
      workflow: folder.name,
      code: problem.code,
      path: placeOf(WORKFLOWS_DIRECTORY, folder.name, problem.path),
      key: problem.key ?? null,
      message: problem.message,
    }));
  });
  return { judged: true, agents, skills, workflows };
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
    /** The workflow folder the path is in; `null` for any other path. */
    workflow: string | null;
  }[];
  /** The agents the Draft touches, or that name a skill it touches, judged on the Draft's state. */
  problems: AgentDraftProblem[];
  /** The skills the Draft touches, judged on the Draft's state. */
  skillProblems: AgentDraftSkillProblem[];
  /** The workflows the Draft touches, or that name an agent it changes, judged on the Draft's state. */
  workflowProblems: AgentDraftWorkflowProblem[];
  /** False when the Draft could not be judged: the problem lists are then empty, not clean. */
  judged: boolean;
  /** Why it was not judged; `null` when it was. */
  notJudgedReason: NotJudgedReason | null;
  /** Paths of the Draft whose content differs between the base commit and the current one. */
  movedUpstream: string[];
}

/** How often a write retries its whole load, change and save when another write got in first. */
export const DRAFT_WRITE_ATTEMPTS = 3;

/** The folder a Draft path is in below `directory` (`<directory>/<name>/...`), or `null`. */
const folderNameOf = (directory: string, path: string): string | null => {
  const [top, name, ...rest] = path.split('/');
  return top === directory && name && rest.length > 0 ? name : null;
};

/**
 * Shows the Draft whole: its problems (see `judgeDraftState`) and its paths that changed upstream
 * by blob id. A Draft that could not be judged says so, with empty problem lists; the Draft itself
 * is still shown.
 */
@Injectable()
export class AgentDraftReader {
  private readonly memos: BaseNameMemos = { agentSkills: new Map(), workflowAgents: new Map() };

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
      skill: folderNameOf(SKILLS_DIRECTORY, path),
      workflow: folderNameOf(WORKFLOWS_DIRECTORY, path),
    }));
    const view = {
      baseCommit,
      currentCommit,
      version: draft.version,
      files,
      problems: [] as AgentDraftProblem[],
      skillProblems: [] as AgentDraftSkillProblem[],
      workflowProblems: [] as AgentDraftWorkflowProblem[],
      judged: true,
      notJudgedReason: null as NotJudgedReason | null,
      movedUpstream: [] as string[],
    };
    if (baseCommit === null || files.length === 0) return view;
    const [judged, movedUpstream] = await Promise.all([
      this.judge(draft),
      this.movedUpstream(draft, baseCommit, currentCommit),
    ]);
    if (!judged.judged) {
      return { ...view, judged: false, notJudgedReason: judged.reason, movedUpstream };
    }
    return {
      ...view,
      problems: judged.agents,
      skillProblems: judged.skills,
      workflowProblems: judged.workflows,
      movedUpstream,
    };
  }

  /**
   * The problems of the Draft's skills, agents and workflows, or why nothing was judged. A publish must
   * refuse a Draft that was not judged: it never means "no problem".
   */
  judge(draft: AgentDraft): Promise<DraftJudgement> {
    if (draft.baseCommit === null) return Promise.resolve(NOT_READ);
    return judgeDraftState(this.definitions, this.drafts, draft, draft.baseCommit, this.memos);
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
