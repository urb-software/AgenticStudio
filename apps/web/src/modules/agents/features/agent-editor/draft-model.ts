import {
  AGENT_ENTRY_FILE,
  AGENT_NAME_PATTERN,
  MODEL_DEFAULT,
  RESERVED_AGENT_NAMES,
  validateAgentFiles,
  validateAgentFolder,
  type AgentEntry,
} from '@agentic-studio/agent-definitions';
import {
  fromBaseSkill,
  fromDraftSkill,
  NAMES_TOUCHED_SKILL,
  skillCheckProblems,
} from './skill-model';
import { fromBaseWorkflow, fromDraftWorkflow, NAMES_CHANGED_AGENT } from './workflow-model';
import type {
  AgentDraftFileOutput,
  AgentDraftProblemOutput,
  AgentDraftSkillProblemOutput,
  AgentDraftWorkflowProblemOutput,
  AgentSummaryOutput,
  SkillSummaryOutput,
  WorkflowSummaryOutput,
} from '../../../../platform/api';
import {
  placedKey,
  problemTarget,
  type EditorEntry,
  type ListedProblem,
  type ProblemTarget,
} from './editor-model';

export type { ListedProblem };

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
      skill: changed.skill,
      workflow: changed.workflow,
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
    `name: "${name}"`,
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
  if (!/^(agents|skills|workflows)\/[^/]+\/.+/.test(path)) {
    return 'Files live under agents/<name>/, skills/<name>/ or workflows/<name>/: publishing refuses any other path.';
  }
  if (existing.has(path) && !deleted.has(path)) return 'A file is already at this path.';
  return undefined;
}

/** The longest commit message the API takes. */
export const PUBLISH_MESSAGE_MAX = 2000;

/** Why a commit message is refused, or undefined when it is not; the API applies the same rules. */
export function publishMessageError(message: string): string | undefined {
  if (message.length === 0 || message.length > PUBLISH_MESSAGE_MAX) {
    return `Enter a message of 1 to ${PUBLISH_MESSAGE_MAX.toLocaleString('en-US')} characters.`;
  }
  if (message.includes('\0')) return 'The message must not contain a NUL character.';
  const subject = message.split('\n', 1)[0] ?? '';
  if (subject.trim() === '') return 'The first line of the message is its subject: write one.';
  return undefined;
}

function fromDraft(problem: AgentDraftProblemOutput): ListedProblem {
  const folder = `agents/${problem.agent}`;
  const target: ProblemTarget = {
    path: problem.path === folder ? `${folder}/${AGENT_ENTRY_FILE}` : problem.path,
  };
  const key = placedKey(problem.code, problem.key);
  if (key) target.key = key;
  return {
    agent: problem.agent,
    skill: null,
    code: problem.code,
    message: problem.message,
    target,
  };
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
  standings?: ReadonlyMap<string, { valid: boolean }>,
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
  if (result.ok) {
    return standings ? skillCheckProblems(agent, result.definition.skills, standings) : [];
  }
  return result.problems.map((problem) => ({
    agent,
    skill: null,
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

/**
 * The API's skill checks of agents the browser judges itself, for skills the browser has no
 * verdict on (`unjudged`: the list was cut): they stay, since the browser's check skips them.
 */
export function keptSkillCheckProblems(
  draft: readonly AgentDraftProblemOutput[],
  agents: ReadonlySet<string>,
  unjudged: (skill: string) => boolean,
): ListedProblem[] {
  return draft
    .filter(
      (problem) =>
        agents.has(problem.agent) &&
        (problem.code === 'skill_missing' || problem.code === 'skill_invalid') &&
        problem.key !== null &&
        unjudged(problem.key),
    )
    .map(fromDraft);
}

export interface ProblemSources {
  /** The agents as listed at the commit the editor reads. */
  base: readonly AgentSummaryOutput[];
  /** The skills as listed at that commit. */
  baseSkills?: readonly SkillSummaryOutput[];
  /** What the API found in the agent folders the Draft touches and in agents naming a touched skill. */
  draft: readonly AgentDraftProblemOutput[];
  /** What the API found in the skill folders the Draft touches. */
  draftSkills?: readonly AgentDraftSkillProblemOutput[];
  /** The agent folders the Draft touches. */
  touched: ReadonlySet<string>;
  /** The skill folders the Draft touches. */
  touchedSkills?: ReadonlySet<string>;
  /** The agents the Draft does not touch that name a touched skill: judged with the Draft. */
  named?: ReadonlySet<string>;
  /** The validation of the open agent run in the browser, which is newer than the API's. */
  live?: { agent: string; problems: readonly ListedProblem[] };
  /** Problems the browser keeps from the API beside its own (see `keptSkillCheckProblems`). */
  kept?: readonly ListedProblem[];
  /** The workflows as listed at the commit the editor reads. */
  baseWorkflows?: readonly WorkflowSummaryOutput[];
  /** What the API found in the workflow folders the Draft touches and in workflows naming a changed agent. */
  draftWorkflows?: readonly AgentDraftWorkflowProblemOutput[];
  /** The workflow folders the Draft touches. */
  touchedWorkflows?: ReadonlySet<string>;
  /** The workflows the Draft does not touch that name an agent it changes: judged with the Draft. */
  namedWorkflows?: ReadonlySet<string>;
  /** The open workflow as the browser judges it, which is newer than the API's. */
  liveWorkflow?: { workflow: string; problems: readonly ListedProblem[] };
  /** The same for the open skill, with the agents that name it judged against it. */
  liveSkill?: {
    skill: string;
    problems: readonly ListedProblem[];
    naming: ReadonlyMap<string, readonly ListedProblem[]>;
    /** The API's problems in files of the skill the browser holds no text of. */
    kept?: readonly ListedProblem[];
  };
}

/**
 * The problems to show, for the set the API judges: the base's for what the Draft leaves alone,
 * the Draft's for the skills and agents it touches and the agents naming a touched skill.
 */
export function listProblems({
  base,
  baseSkills = [],
  draft,
  draftSkills = [],
  touched,
  touchedSkills = new Set(),
  named = new Set(),
  kept = [],
  live,
  liveSkill,
  baseWorkflows = [],
  draftWorkflows = [],
  touchedWorkflows = new Set(),
  namedWorkflows = new Set(),
  liveWorkflow,
}: ProblemSources): ListedProblem[] {
  const listed: ListedProblem[] = [];
  for (const agent of base) {
    if (agent.source !== 'definitions' || touched.has(agent.name) || named.has(agent.name))
      continue;
    for (const problem of agent.problems) {
      listed.push({
        agent: agent.name,
        skill: null,
        code: problem.code,
        message: problem.message,
        target: problemTarget(agent.name, problem),
      });
    }
  }
  for (const problem of draft) {
    if (problem.agent === live?.agent || liveSkill?.naming.has(problem.agent)) continue;
    const item = fromDraft(problem);
    const indirect = named.has(problem.agent) && !touched.has(problem.agent);
    listed.push(indirect ? { ...item, note: NAMES_TOUCHED_SKILL } : item);
  }
  if (live) listed.push(...live.problems);
  listed.push(...kept);
  for (const skill of baseSkills) {
    if (touchedSkills.has(skill.name)) continue;
    listed.push(...fromBaseSkill(skill));
  }
  for (const problem of draftSkills) {
    if (problem.skill !== liveSkill?.skill) listed.push(fromDraftSkill(problem));
  }
  if (liveSkill) {
    listed.push(...liveSkill.problems, ...(liveSkill.kept ?? []));
    for (const problems of liveSkill.naming.values()) listed.push(...problems);
  }
  for (const workflow of baseWorkflows) {
    if (touchedWorkflows.has(workflow.name) || namedWorkflows.has(workflow.name)) continue;
    listed.push(...fromBaseWorkflow(workflow));
  }
  for (const problem of draftWorkflows) {
    if (problem.workflow === liveWorkflow?.workflow) continue;
    const item = fromDraftWorkflow(problem);
    const indirect =
      namedWorkflows.has(problem.workflow) && !touchedWorkflows.has(problem.workflow);
    listed.push(indirect ? { ...item, note: NAMES_CHANGED_AGENT } : item);
  }
  if (liveWorkflow) listed.push(...liveWorkflow.problems);
  return listed;
}
