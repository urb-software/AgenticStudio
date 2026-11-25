import {
  AGENT_ENTRY_FILE,
  AGENT_NAME_PATTERN,
  MODEL_DEFAULT,
  RESERVED_AGENT_NAMES,
  validateAgentFiles,
  validateAgentFolder,
  type AgentEntry,
} from '@agentic-studio/agent-definitions';
import type {
  AgentDraftFileOutput,
  AgentDraftProblemOutput,
  AgentSummaryOutput,
} from '../../../../platform/api';
import { problemTarget, type EditorEntry, type ProblemTarget } from './editor-model';

const AGENT_PATH = /^agents\/([^/]+)\//;

/** The folder of the agent that holds `path`, or null for a file elsewhere. */
export function agentOfPath(path: string): string | null {
  return AGENT_PATH.exec(path)?.[1] ?? null;
}

/** The Repository's tree with the Draft laid over it: changed files carry their mark. */
export function overlayDraft(
  entries: readonly EditorEntry[],
  files: readonly AgentDraftFileOutput[],
): EditorEntry[] {
  if (files.length === 0) return [...entries];
  const changes = new Map(files.map((file) => [file.path, file]));
  const result: EditorEntry[] = entries.map((item) => {
    const changed = changes.get(item.path);
    if (!changed) return item;
    changes.delete(item.path);
    if (changed.change === 'deleted') return { ...item, change: 'deleted' };
    return { ...item, size: changed.size, change: changed.change, movedFrom: changed.movedFrom };
  });
  for (const changed of changes.values()) {
    if (changed.change === 'deleted') continue;
    result.push({
      path: changed.path,
      kind: 'file',
      size: changed.size,
      openable: true,
      agent: agentOfPath(changed.path),
      change: changed.change,
      movedFrom: changed.movedFrom,
    });
  }
  return result;
}

/** The text of a new agent's entry file: it passes the validation for a plain name. */
export function newAgentFile(name: string, provider: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Describe what this agent is for.',
    `provider: ${provider}`,
    `model: ${MODEL_DEFAULT}`,
    '---',
    '',
    'Write the instructions for this agent here.',
    '',
  ].join('\n');
}

/** Why a name cannot be a new agent's, or undefined when it can. */
export function agentNameError(name: string, taken: ReadonlySet<string>): string | undefined {
  if (name === '') return 'Enter a name for the agent.';
  if (!AGENT_NAME_PATTERN.test(name)) {
    return 'Use 1 to 64 characters: lower-case letters, digits and "-", starting with a letter or digit.';
  }
  if ((RESERVED_AGENT_NAMES as readonly string[]).includes(name)) {
    return 'This name is reserved by Studio.';
  }
  if (taken.has(name)) return 'An agent folder with this name already exists.';
  return undefined;
}

/** Why a path cannot be a new file's, or undefined when it can; the API applies the rules again. */
export function pathError(
  path: string,
  existing: ReadonlySet<string>,
  deleted: ReadonlySet<string> = new Set(),
): string | undefined {
  if (path === '') return 'Enter the path of the file.';
  const [refusal] = validateAgentFiles([{ path, kind: 'file', size: 0 }]);
  if (refusal) return refusal.message;
  if (!/^agents\/[^/]+\/.+/.test(path)) {
    return 'Files live under agents/<name>/: publishing refuses any other path.';
  }
  if (existing.has(path) && !deleted.has(path)) return 'A file is already at this path.';
  return undefined;
}

/** One problem to show in the list and in the file, from any of its sources. */
export interface ListedProblem {
  agent: string;
  code: string;
  message: string;
  target: ProblemTarget;
}

function fromDraft(problem: AgentDraftProblemOutput): ListedProblem {
  const target: ProblemTarget = { path: problem.path };
  if (problem.key) target.key = problem.key;
  return { agent: problem.agent, code: problem.code, message: problem.message, target };
}

/**
 * The problems of the agent folder `agent` as the shared validation finds them in the files as
 * they stand now. `entryText` is the entry file's text; undefined while it is not known, which
 * gives no answer rather than a wrong one.
 */
export function validateAgentLive(
  agent: string,
  entries: readonly EditorEntry[],
  entryText: string | undefined,
  sizes: ReadonlyMap<string, number>,
): ListedProblem[] | undefined {
  const prefix = `agents/${agent}/`;
  const folder: AgentEntry[] = [];
  for (const item of entries) {
    if (!item.path.startsWith(prefix) || item.change === 'deleted') continue;
    const path = item.path.slice(prefix.length);
    const size = sizes.get(item.path) ?? item.size;
    if (path === AGENT_ENTRY_FILE) {
      if (entryText === undefined) return undefined;
      folder.push({ path, kind: item.kind, size, content: entryText });
    } else {
      folder.push({ path, kind: item.kind, size });
    }
  }
  const result = validateAgentFolder(agent, folder);
  if (result.ok) return [];
  return result.problems.map((problem) => ({
    agent,
    code: problem.code,
    message: problem.message,
    target: problemTarget(agent, {
      code: problem.code,
      path: problem.path,
      key: problem.key ?? null,
      message: problem.message,
    }),
  }));
}

export interface ProblemSources {
  /** The agents as listed at the commit the editor reads. */
  base: readonly AgentSummaryOutput[];
  /** What the API found in the agent folders the Draft touches. */
  draft: readonly AgentDraftProblemOutput[];
  /** The agent folders the Draft touches. */
  touched: ReadonlySet<string>;
  /** The validation of the open agent run in the browser, which is newer than the API's. */
  live?: { agent: string; problems: readonly ListedProblem[] };
}

/** The problems to show: the base's for untouched agents, the Draft's for touched ones. */
export function listProblems({ base, draft, touched, live }: ProblemSources): ListedProblem[] {
  const listed: ListedProblem[] = [];
  for (const agent of base) {
    if (agent.source !== 'definitions' || touched.has(agent.name)) continue;
    for (const problem of agent.problems) {
      listed.push({
        agent: agent.name,
        code: problem.code,
        message: problem.message,
        target: problemTarget(agent.name, problem),
      });
    }
  }
  for (const problem of draft) {
    if (problem.agent !== live?.agent) listed.push(fromDraft(problem));
  }
  if (live) listed.push(...live.problems);
  return listed;
}
