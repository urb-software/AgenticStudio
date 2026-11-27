import {
  AGENT_NAME_PATTERN,
  checkWorkflowAgents,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  validateWorkflowFolder,
  WORKFLOW_ENTRY_FILE,
  workflowAgentNames,
  type AgentEntry,
  type WorkflowDefinition,
} from '@agentic-studio/agent-definitions';
import type {
  AgentDraftWorkflowProblemOutput,
  AgentSummaryOutput,
  WorkflowItemOutput,
  WorkflowSummaryOutput,
} from '../../../../platform/api';
import {
  placedKey,
  type EditorEntry,
  type ListedProblem,
  type ProblemTarget,
} from './editor-model';

const WORKFLOW_PATH = /^workflows\/([^/]+)\//;

/** The folder of the workflow that holds `path`, or null for a file elsewhere. */
export function workflowOfPath(path: string): string | null {
  return WORKFLOW_PATH.exec(path)?.[1] ?? null;
}

/** The entry file of a workflow folder. */
export const workflowEntryPath = (workflow: string) =>
  `workflows/${workflow}/${WORKFLOW_ENTRY_FILE}`;

/** The placeholder agent names of the template: the operator replaces them with agents of the Repository. */
export const TEMPLATE_AGENTS = { implement: 'implementer', review: 'reviewer' } as const;

/** The text of a new workflow's entry file ("implement, then review"): it passes the validation once its agents exist. */
export function newWorkflowFile(name: string): string {
  return [
    '---',
    `name: "${name}"`,
    'description: Describe what this workflow is for.',
    'sequence:',
    '  - id: implement',
    '    kind: work',
    `    agent: "${TEMPLATE_AGENTS.implement}"`,
    '  - id: review',
    '    kind: review',
    `    agent: "${TEMPLATE_AGENTS.review}"`,
    '---',
    '',
    'Describe this workflow for the operator here. Replace the agent names above with agents of the Repository.',
    '',
  ].join('\n');
}

/** Why a name cannot be a new workflow's, or undefined when it can. */
export function workflowNameError(name: string, taken: ReadonlySet<string>): string | undefined {
  if (name === '') return 'Enter a name for the workflow.';
  if (!AGENT_NAME_PATTERN.test(name)) {
    return 'Use 1 to 64 characters: lower-case letters, digits and "-", starting with a letter or digit.';
  }
  if (taken.has(name)) return 'A workflow folder with this name already exists.';
  return undefined;
}

const workflowTarget = (
  workflow: string,
  problem: { code: string; path: string; key?: string | null },
): ProblemTarget => {
  const path = `workflows/${workflow}/${problem.path === '' ? WORKFLOW_ENTRY_FILE : problem.path}`;
  const key = placedKey(problem.code, problem.key);
  return key ? { path, key } : { path };
};

/** A workflow problem as listed: from the API's Workflow list (paths relative to the folder). */
export function fromBaseWorkflow(workflow: WorkflowSummaryOutput): ListedProblem[] {
  return workflow.problems.map((problem) => ({
    agent: null,
    skill: null,
    workflow: workflow.name,
    code: problem.code,
    message: problem.message,
    target: workflowTarget(workflow.name, problem),
  }));
}

/** A workflow problem as listed: from the Draft answer (paths from the Repository root). */
export function fromDraftWorkflow(problem: AgentDraftWorkflowProblemOutput): ListedProblem {
  const folder = `workflows/${problem.workflow}`;
  const target: ProblemTarget = {
    path: problem.path === folder ? `${folder}/${WORKFLOW_ENTRY_FILE}` : problem.path,
  };
  const key = placedKey(problem.code, problem.key);
  if (key) target.key = key;
  return {
    agent: null,
    skill: null,
    workflow: problem.workflow,
    code: problem.code,
    message: problem.message,
    target,
  };
}

const filesOf = (folder: readonly AgentEntry[]) => folder.filter((item) => item.kind === 'file');

/** A folder the validation refuses by the declared count and sizes alone, as the API's reader sees it. */
function refusedBySize(folder: readonly AgentEntry[]): boolean {
  const files = filesOf(folder);
  return (
    files.length > MAX_FILES ||
    files.some((item) => item.size > MAX_FILE_BYTES) ||
    files.reduce((sum, item) => sum + item.size, 0) > MAX_FOLDER_BYTES
  );
}

/** A workflow of the Draft's state as the browser judges it: its problems, and its phases when the text parses. */
export interface LiveWorkflow {
  problems: ListedProblem[];
  /** The parsed workflow; absent while the shared validation finds a problem in the folder itself. */
  definition?: WorkflowDefinition;
}

/**
 * The workflow folder `workflow` as the API judges it: the entry file is read (not for a folder
 * its sizes refuse, which drops its "cannot be read" reasons), then its phases are checked
 * against `standings`, the agents of the Draft's state. Undefined while the entry text is unknown.
 */
export function validateWorkflowLive(
  workflow: string,
  entries: readonly EditorEntry[],
  entryText: string | undefined,
  sizes: ReadonlyMap<string, number>,
  standings: ReadonlyMap<string, { valid: boolean }>,
): LiveWorkflow | undefined {
  const prefix = `workflows/${workflow}/`;
  const folder: AgentEntry[] = [];
  for (const item of entries) {
    if (!item.path.startsWith(prefix) || item.change === 'deleted') continue;
    folder.push({
      path: item.path.slice(prefix.length),
      kind: item.kind,
      size: sizes.get(item.path) ?? item.size,
    });
  }
  const refused = refusedBySize(folder);
  const entryExists = folder.some((item) => item.path === WORKFLOW_ENTRY_FILE);
  if (entryExists && !refused && entryText === undefined) return undefined;
  const given = folder.map((item) =>
    item.path === WORKFLOW_ENTRY_FILE && !refused && item.kind === 'file' && entryText !== undefined
      ? { ...item, content: entryText }
      : item,
  );
  const result = validateWorkflowFolder(workflow, given);
  const listed = (problem: {
    code: string;
    path: string;
    key?: string | null;
    message: string;
  }) => ({
    agent: null,
    skill: null,
    workflow,
    code: problem.code,
    message: problem.message,
    target: workflowTarget(workflow, problem),
  });
  if (result.ok) {
    return {
      definition: result.definition,
      problems: checkWorkflowAgents(result.definition, standings).map(listed),
    };
  }
  return {
    problems: result.problems
      .filter((problem) => problem.code !== 'entry_unreadable' || !refused)
      .map(listed),
  };
}

/**
 * Whether each agent folder of the Draft's state is valid; absent means it does not exist. An
 * agent the Draft touches (or the API judged) is valid when it has no problem; one the Draft
 * leaves alone is as the agents list has it. The open agent is judged by the browser, which is newer.
 */
export function agentStandings(input: {
  entries: readonly EditorEntry[];
  baseAgents: ReadonlyMap<string, AgentSummaryOutput>;
  /** The agents the Draft touches. */
  touched: ReadonlySet<string>;
  /** The agents the API found a problem in, on the Draft's state. */
  withProblems: ReadonlySet<string>;
  /** The open agent, when the browser judged it. */
  live?: { agent: string; valid: boolean };
}): Map<string, { valid: boolean }> {
  const standings = new Map<string, { valid: boolean }>();
  for (const item of input.entries) {
    const name = item.agent;
    if (name === null || item.change === 'deleted' || standings.has(name)) continue;
    let valid: boolean;
    if (input.live?.agent === name) valid = input.live.valid;
    else if (input.withProblems.has(name)) valid = false;
    else if (input.touched.has(name)) valid = true;
    else valid = (input.baseAgents.get(name)?.problems.length ?? 0) === 0;
    standings.set(name, { valid });
  }
  return standings;
}

/** The phases of a parsed workflow as the diagram shows them, with the agents as the Draft leaves them. */
export function diagramItems(
  definition: WorkflowDefinition,
  standings: ReadonlyMap<string, { valid: boolean }>,
  baseAgents: ReadonlyMap<string, AgentSummaryOutput>,
): WorkflowItemOutput[] {
  return definition.sequence.map((item): WorkflowItemOutput => {
    if (item.kind === 'checkpoint') return { kind: 'checkpoint', id: item.id, text: item.text };
    const standing = standings.get(item.agent);
    const agentState = standing === undefined ? 'missing' : standing.valid ? 'valid' : 'invalid';
    const provider = agentState === 'valid' ? (baseAgents.get(item.agent)?.provider ?? null) : null;
    return {
      kind: item.kind,
      id: item.id,
      agent: item.agent,
      agentState,
      provider: provider === 'claude_code' || provider === 'codex' ? provider : null,
      usable: agentState === 'valid',
    };
  });
}

/** The note shown beside a problem of a workflow the Draft does not change. */
export const NAMES_CHANGED_AGENT =
  'This workflow is not changed, but it names an agent the Draft changes.';

/**
 * The workflows that name `agent` as the Draft leaves them: the base workflows the agent's
 * detail lists, except those whose entry file the Draft writes or deletes, and the workflows whose
 * entry file the Draft writes, from `draftTexts` (by entry path).
 */
export function workflowsNaming(
  agent: string,
  baseUsers: readonly string[],
  entries: readonly EditorEntry[],
  draftTexts: ReadonlyMap<string, string>,
): string[] {
  const names = new Set<string>();
  const changedEntry = new Set<string>();
  for (const item of entries) {
    const workflow = workflowOfPath(item.path);
    if (workflow === null || item.path !== workflowEntryPath(workflow) || !item.change) continue;
    changedEntry.add(workflow);
    if (item.change === 'deleted') continue;
    const text = draftTexts.get(item.path);
    if (text !== undefined && workflowAgentNames(text).includes(agent)) names.add(workflow);
  }
  for (const workflow of baseUsers) {
    if (!changedEntry.has(workflow)) names.add(workflow);
  }
  return [...names].sort();
}

const AGENT_CHECK_CODES = new Set(['phase_agent_missing', 'phase_agent_invalid']);

/**
 * The base workflows the Draft judges although it leaves them alone: those the API's Draft answer
 * lists, and those whose base problem is an agent the Draft changes (it may be fixed by it).
 */
export function namedWorkflows(
  baseWorkflows: readonly WorkflowSummaryOutput[],
  draftProblems: readonly AgentDraftWorkflowProblemOutput[],
  touchedWorkflows: ReadonlySet<string>,
  changedAgents: ReadonlySet<string>,
): Set<string> {
  const named = new Set<string>();
  for (const problem of draftProblems) {
    if (!touchedWorkflows.has(problem.workflow)) named.add(problem.workflow);
  }
  for (const workflow of baseWorkflows) {
    if (touchedWorkflows.has(workflow.name)) continue;
    if (
      workflow.problems.some(
        (problem) =>
          AGENT_CHECK_CODES.has(problem.code) &&
          problem.key !== null &&
          changedAgents.has(problem.key),
      )
    ) {
      named.add(workflow.name);
    }
  }
  return named;
}

/** What the dialog says about the workflows an agent's rename or delete would break. */
export function workflowsWarning(workflows: readonly string[], more: boolean): string | undefined {
  if (workflows.length === 0) return undefined;
  const list = workflows.join(', ');
  const tail = more ? ' and possibly more' : '';
  return `${workflows.length === 1 ? 'This workflow names' : 'These workflows name'} this agent and would become invalid: ${list}${tail}.`;
}

/** The entry files of the workflows the Draft adds or modifies. */
export function writtenWorkflowEntries(entries: readonly EditorEntry[]): string[] {
  return entries
    .filter((item) => {
      const workflow = workflowOfPath(item.path);
      return (
        workflow !== null &&
        item.path === workflowEntryPath(workflow) &&
        (item.change === 'added' || item.change === 'modified')
      );
    })
    .map((item) => item.path);
}
