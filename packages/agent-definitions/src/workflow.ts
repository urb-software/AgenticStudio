import { utf8Length } from './front-matter.js';
import {
  AGENT_NAME_PATTERN,
  DESCRIPTION_MAX_LENGTH,
  FORBIDDEN_KEYS,
  MAX_INSTRUCTIONS_BYTES,
  RESERVED_AGENT_NAMES,
  SHELL_LINE,
  SKILL_CLI_DISCOVERED_FILES,
  WORKFLOW_CHECKPOINT_KEYS,
  WORKFLOW_CHECKPOINT_TEXT_MAX_LENGTH,
  WORKFLOW_DEFAULT_SEND_BACKS,
  WORKFLOW_ENTRY_FILE,
  WORKFLOW_FORBIDDEN_KEYS,
  WORKFLOW_KNOWN_KEYS,
  WORKFLOW_MAX_ITEMS,
  WORKFLOW_PHASE_INSTRUCTIONS_MAX_BYTES,
  WORKFLOW_PHASE_KEYS,
} from './limits.js';
import { quote, WORKFLOW_SUBJECT, workflowProblem, type Problem } from './problems.js';
import type { WorkflowProblemCode } from './problems.js';
import {
  DESCRIPTION_FORBIDDEN,
  judgeEntries,
  lower,
  normalise,
  oneLine,
  readEntry,
  requiredText,
  type Add as SharedAdd,
  type AgentEntry,
  type Kind,
} from './validate.js';

/** A phase of kind `work` (may change the Working copy) or `review` (ends with a Verdict). */
export interface WorkflowPhase {
  id: string;
  kind: 'work' | 'review';
  /** The name of the agent that does the phase. */
  agent: string;
  /** Extra instructions for this phase only; absent when the item sets none. */
  instructions?: string;
}

/** A point where the Run waits for the operator. */
export interface WorkflowCheckpoint {
  id: string;
  kind: 'checkpoint';
  /** What the operator sees; may hold line breaks. */
  text: string;
}

export type WorkflowItem = WorkflowPhase | WorkflowCheckpoint;

export interface WorkflowDefinition {
  name: string;
  description: string;
  /** The most send-backs per Run: the `send-backs` key, or WORKFLOW_DEFAULT_SEND_BACKS. */
  sendBacks: number;
  sequence: WorkflowItem[];
  /** The Markdown after the front matter; for the operator only, never handed to an agent. */
  documentation: string;
  /** Every file of the folder, the entry file included. */
  files: { path: string; size: number }[];
}

type WorkflowProblem = Problem<WorkflowProblemCode>;

export type WorkflowFolderResult =
  { ok: true; definition: WorkflowDefinition } | { ok: false; problems: WorkflowProblem[] };

/** What the check needs to know of an agent that exists at the workflow's commit. */
export interface AgentStanding {
  valid: boolean;
}

const WORKFLOW_KIND: Kind = {
  subject: WORKFLOW_SUBJECT,
  entryFile: WORKFLOW_ENTRY_FILE,
  cliFiles: lower(SKILL_CLI_DISCOVERED_FILES),
  measureAllText: true,
};

const FORBIDDEN = new Set(FORBIDDEN_KEYS.map(normalise));
const WORKFLOW_FORBIDDEN = new Set(WORKFLOW_FORBIDDEN_KEYS.map(normalise));
const KNOWN = new Set<string>(WORKFLOW_KNOWN_KEYS);
const PHASE_KEYS = new Set<string>(WORKFLOW_PHASE_KEYS);
const CHECKPOINT_KEYS = new Set<string>(WORKFLOW_CHECKPOINT_KEYS);
const ITEM_KINDS = new Set(['work', 'review', 'checkpoint']);
const FORBIDDEN_WORDING =
  'asks for tools, permissions, hooks, MCP servers, memory or isolation, which a definition ' +
  'cannot set';

type Add = (code: WorkflowProblemCode, key?: string, message?: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What an item problem says: it quotes the item id and nothing the item holds. */
function itemMessage(code: WorkflowProblemCode, id: string): string {
  const item = `The item ${quote(id)}`;
  switch (code) {
    case 'key_missing':
      return `${item} lacks a required key.`;
    case 'key_invalid':
      return `${item} has a key with a value of the wrong kind or length.`;
    case 'unknown_key':
      return `${item} has a key that its kind does not allow.`;
    case 'forbidden_key':
      return `${item} has a key that ${FORBIDDEN_WORDING}.`;
    case 'workflow_forbidden_key':
      return `${item} has a key that configures a model, Provider, skills, limits or a command, which a workflow cannot set.`;
    case 'instructions_too_large':
      return `The instructions of ${item.slice(4)} are larger than the size limit.`;
    default:
      return `${item} holds an inline shell line, which a workflow cannot carry.`;
  }
}

/** Judges the entries of one workflow folder. Pure: reads nothing, starts nothing. */
export function validateWorkflowFolder(
  folderName: string,
  entries: readonly AgentEntry[],
): WorkflowFolderResult {
  const judged = judgeEntries(entries, WORKFLOW_KIND);
  const { fileEntries } = judged;
  const problems: WorkflowProblem[] = [...judged.problems] as WorkflowProblem[];
  const tooLarge = (path: string) =>
    problems.some((item) => item.code === 'file_too_large' && item.path === path);

  if (!AGENT_NAME_PATTERN.test(folderName)) problems.push(workflowProblem('name_invalid', ''));
  else if ((RESERVED_AGENT_NAMES as readonly string[]).includes(folderName)) {
    problems.push(workflowProblem('name_reserved', ''));
  }

  for (const entry of fileEntries) {
    if (entry.path !== WORKFLOW_ENTRY_FILE) {
      problems.push(workflowProblem('workflow_extra_file', entry.path));
    }
  }

  const entryFile = fileEntries.find((entry) => entry.path === WORKFLOW_ENTRY_FILE);
  let definition: Omit<WorkflowDefinition, 'files'> | undefined;
  if (entryFile) {
    definition = judgeEntry(folderName, entryFile, problems, tooLarge(WORKFLOW_ENTRY_FILE));
  } else if (!problems.some((item) => item.path === WORKFLOW_ENTRY_FILE)) {
    problems.push(workflowProblem('entry_missing', WORKFLOW_ENTRY_FILE));
  }

  // A refusal always carries a reason.
  if (problems.length === 0 && !definition) {
    problems.push(workflowProblem('entry_missing', WORKFLOW_ENTRY_FILE));
  }
  if (problems.length > 0 || !definition) return { ok: false, problems };
  return {
    ok: true,
    definition: { ...definition, files: fileEntries.map(({ path, size }) => ({ path, size })) },
  };
}

function judgeEntry(
  folderName: string,
  entry: AgentEntry,
  problems: WorkflowProblem[],
  sizeRefused: boolean,
): Omit<WorkflowDefinition, 'files'> | undefined {
  const path = WORKFLOW_ENTRY_FILE;
  const add: Add = (code, key, message) => problems.push(workflowProblem(code, path, key, message));
  // A reason of an agent only (a Provider or model) is never given by the shared readers.
  const addShared: SharedAdd = (code, key) => add(code as WorkflowProblemCode, key);
  const parsed = readEntry(entry.content, sizeRefused, addShared);
  if (!parsed) return undefined;
  const rawShell = SHELL_LINE.test(entry.content as string);
  if (rawShell) add('shell_line');

  const before = problems.length;
  const { values, instructions } = parsed;

  for (const key of Object.keys(values)) {
    if (FORBIDDEN.has(normalise(key))) add('forbidden_key', key);
    else if (WORKFLOW_FORBIDDEN.has(normalise(key))) add('workflow_forbidden_key', key);
    else if (!KNOWN.has(key)) add('unknown_key', key);
  }
  if (utf8Length(instructions) > MAX_INSTRUCTIONS_BYTES) add('instructions_too_large');

  const name = requiredText(values, 'name', addShared);
  if (name !== undefined) {
    if (!AGENT_NAME_PATTERN.test(name)) add('name_invalid');
    else if (name !== folderName) add('name_mismatch');
  }

  const description = requiredText(values, 'description', addShared);
  if (description !== undefined && !oneLine(description, DESCRIPTION_MAX_LENGTH)) {
    add('key_invalid', 'description');
  }

  const sendBacks = judgeSendBacks(values['send-backs'], add);
  const carried: unknown[] = [description];
  const sequence = judgeSequence(values['sequence'], add, carried);

  // A YAML escape can write a shell line that the raw text does not show: test what was decoded.
  if (!rawShell && carried.some((item) => typeof item === 'string' && SHELL_LINE.test(item))) {
    add('shell_line');
  }

  if (problems.length > before || name === undefined || description === undefined || !sequence) {
    return undefined;
  }
  return { name, description, sendBacks, sequence, documentation: instructions };
}

function judgeSendBacks(value: unknown, add: Add): number {
  if (value === undefined || value === null) return WORKFLOW_DEFAULT_SEND_BACKS;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    add('key_invalid', 'send-backs');
    return WORKFLOW_DEFAULT_SEND_BACKS;
  }
  if (value < 0 || value > WORKFLOW_DEFAULT_SEND_BACKS) add('send_backs_out_of_range');
  return value;
}

/** The items of a `sequence` value, reporting every rule they and their order break. */
function judgeSequence(value: unknown, add: Add, carried: unknown[]): WorkflowItem[] | undefined {
  if (value === undefined || value === null) {
    add('key_missing', 'sequence');
    return undefined;
  }
  if (!Array.isArray(value)) {
    add('key_invalid', 'sequence');
    return undefined;
  }
  // Past the limit the items are not judged, so a long list cannot flood the problems.
  if (value.length > WORKFLOW_MAX_ITEMS) {
    add('sequence_too_long');
    return undefined;
  }

  const items: WorkflowItem[] = [];
  const kinds: string[] = [];
  const seen = new Set<string>();
  const repeated = new Set<string>();
  let kindsKnown = true;
  for (const raw of value) {
    const id = isRecord(raw) && typeof raw['id'] === 'string' ? raw['id'] : undefined;
    const kind = isRecord(raw) && typeof raw['kind'] === 'string' ? raw['kind'] : undefined;
    if (
      id === undefined ||
      !AGENT_NAME_PATTERN.test(id) ||
      kind === undefined ||
      !ITEM_KINDS.has(kind)
    ) {
      add('item_invalid', 'sequence');
      kindsKnown = false;
      continue;
    }
    kinds.push(kind);
    if (seen.has(id) && !repeated.has(id)) {
      repeated.add(id);
      add('item_id_duplicate', id);
    }
    seen.add(id);
    const item = judgeItem(raw as Record<string, unknown>, id, kind, add, carried);
    if (item) items.push(item);
  }

  if (kindsKnown) judgeOrder(kinds, add);
  return items.length === value.length ? items : undefined;
}

function judgeItem(
  raw: Record<string, unknown>,
  id: string,
  kind: string,
  add: Add,
  carried: unknown[],
): WorkflowItem | undefined {
  let ok = true;
  const report = (code: WorkflowProblemCode) => {
    ok = false;
    add(code, id, itemMessage(code, id));
  };
  const allowed = kind === 'checkpoint' ? CHECKPOINT_KEYS : PHASE_KEYS;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN.has(normalise(key))) report('forbidden_key');
    else if (WORKFLOW_FORBIDDEN.has(normalise(key))) report('workflow_forbidden_key');
    else if (!allowed.has(key)) report('unknown_key');
  }

  if (kind === 'checkpoint') {
    const text = raw['text'];
    carried.push(text);
    if (text === undefined || text === null) report('key_missing');
    else if (
      typeof text !== 'string' ||
      text.trim() === '' ||
      text.length > WORKFLOW_CHECKPOINT_TEXT_MAX_LENGTH ||
      DESCRIPTION_FORBIDDEN.test(text.replaceAll('\n', ''))
    ) {
      report('key_invalid');
    } else if (ok) return { id, kind: 'checkpoint', text };
    return undefined;
  }

  const agent = raw['agent'];
  if (agent === undefined || agent === null) report('key_missing');
  else if (typeof agent !== 'string' || !AGENT_NAME_PATTERN.test(agent)) report('key_invalid');

  const extra = raw['instructions'];
  carried.push(extra);
  let instructions: string | undefined;
  if (extra !== undefined && extra !== null) {
    if (typeof extra !== 'string') report('key_invalid');
    // The front matter limit is as large, so this holds only if one of the two limits changes.
    else if (utf8Length(extra) > WORKFLOW_PHASE_INSTRUCTIONS_MAX_BYTES) {
      report('instructions_too_large');
    } else instructions = extra;
  }

  if (!ok || typeof agent !== 'string') return undefined;
  return {
    id,
    kind: kind as 'work' | 'review',
    agent,
    ...(instructions === undefined ? {} : { instructions }),
  };
}

/** The order rules, each with its own reason; the kinds are all known here. */
function judgeOrder(kinds: readonly string[], add: Add): void {
  if (!kinds.some((kind) => kind !== 'checkpoint')) add('no_phase');
  if (kinds[0] === 'review') add('review_first');
  else {
    const firstReview = kinds.indexOf('review');
    if (firstReview !== -1 && !kinds.slice(0, firstReview).includes('work')) {
      add('review_before_work');
    }
  }
  if (kinds[0] === 'checkpoint') add('checkpoint_first');
  if (kinds[kinds.length - 1] === 'checkpoint') add('checkpoint_last');
  if (kinds.some((kind, index) => kind === 'checkpoint' && kinds[index + 1] === 'checkpoint')) {
    add('checkpoints_adjacent');
  }
}

/**
 * Judges the agents the phases name against the agents at the same commit: an absent one does not
 * exist, one with `valid: false` is invalid. Provider enablement is not judged. Pure.
 */
export function checkWorkflowAgents(
  workflow: Pick<WorkflowDefinition, 'sequence'>,
  agents: ReadonlyMap<string, AgentStanding>,
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = [];
  for (const item of workflow.sequence) {
    if (item.kind === 'checkpoint') continue;
    const standing = agents.get(item.agent);
    if (standing?.valid) continue;
    const missing = standing === undefined;
    problems.push(
      workflowProblem(
        missing ? 'phase_agent_missing' : 'phase_agent_invalid',
        WORKFLOW_ENTRY_FILE,
        item.agent,
        `The phase ${quote(item.id)} names the agent ${quote(item.agent)}, ` +
          (missing ? 'which does not exist.' : 'which is not valid.'),
      ),
    );
  }
  return problems;
}
