import { AGENT_ENTRY_FILE } from '@agentic-studio/agent-definitions';
import type { AgentFileEntryOutput, AgentProblemOutput } from '../../../../platform/api';

/** A file of the tree with what the Draft does to it, if anything. */
export interface EditorEntry extends AgentFileEntryOutput {
  change?: 'added' | 'modified' | 'deleted';
  /** The path a moved file came from, for display. */
  movedFrom?: string | null;
}

/** How a change of the Draft is named in the view. */
export const CHANGE_LABEL = { added: 'Added', modified: 'Modified', deleted: 'Deleted' } as const;

/** The file every agent folder is defined by. */
export const ENTRY_FILE = AGENT_ENTRY_FILE;

/** Monaco language ids; anything else is plain text. */
export type EditorLanguage =
  'markdown' | 'yaml' | 'json' | 'shell' | 'python' | 'javascript' | 'typescript' | 'plaintext';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, EditorLanguage>> = {
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  sh: 'shell',
  bash: 'shell',
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
};

/** The language from the file extension; a name without one (or a dotfile) is plain text. */
export function languageOf(path: string): EditorLanguage {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'plaintext';
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'plaintext';
}

/**
 * The 1-based line of a top-level `key:` inside the front matter of `content`, found here
 * because the API only names the key. Undefined without front matter or without the key there.
 */
export function frontMatterKeyLine(content: string, key: string): number | undefined {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return undefined;
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const keyLine = new RegExp(String.raw`^(?:${escaped}|"${escaped}"|'${escaped}')\s*:`);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trimEnd() === '---') return undefined;
    if (keyLine.test(line)) return index + 1;
  }
  return undefined;
}

export interface ProblemTarget {
  /** The file in the Repository, from its root. */
  path: string;
  /** The front matter key to find in that file. */
  key?: string;
}

const SKILL_NAME_CODES: readonly string[] = [
  'skill_name_invalid',
  'skill_listed_twice',
  'skill_missing',
  'skill_invalid',
];

/** The reasons about the phases and checkpoints of a workflow: their key is an id or an agent name. */
const SEQUENCE_CODES: readonly string[] = [
  'item_invalid',
  'item_id_duplicate',
  'sequence_too_long',
  'phase_agent_reserved',
  'phase_agent_missing',
  'phase_agent_invalid',
  'no_phase',
  'review_first',
  'review_before_work',
  'checkpoint_first',
  'checkpoint_last',
  'checkpoints_adjacent',
];

/**
 * The front matter key to find: for the skill-name reasons the key is a name, so the `skills`
 * line; for the reasons about a workflow's items it is an id or an agent name, so the `sequence` line.
 */
export function placedKey(code: string, key: string | null | undefined): string | undefined {
  if (SKILL_NAME_CODES.includes(code)) return 'skills';
  if (SEQUENCE_CODES.includes(code)) return 'sequence';
  return key || undefined;
}

/** Where a problem of `agent` lives: its file, or the entry file for a folder-level problem. */
export function problemTarget(agent: string, problem: AgentProblemOutput): ProblemTarget {
  const path = `agents/${agent}/${problem.path === '' ? ENTRY_FILE : problem.path}`;
  const key = placedKey(problem.code, problem.key);
  return key ? { path, key } : { path };
}

/** One problem to show in the list and in the file, from any of its sources. */
export interface ListedProblem {
  /** The agent folder the problem is in; null for a skill's. */
  agent: string | null;
  /** The skill folder the problem is in; null for an agent's. */
  skill: string | null;
  /** The workflow folder the problem is in; absent for an agent's or a skill's. */
  workflow?: string | null;
  code: string;
  message: string;
  target: ProblemTarget;
  /** Why an agent the Draft does not change is listed. */
  note?: string;
}

export type TreeNode =
  | {
      kind: 'folder';
      name: string;
      path: string;
      /** The agent a folder is the folder of; null for any other folder. */
      agent: string | null;
      /** The skill a folder is the folder of; null for any other folder. */
      skill: string | null;
      /** The workflow a folder is the folder of; null for any other folder. */
      workflow: string | null;
      children: TreeNode[];
    }
  | { kind: 'file'; name: string; path: string; entry: EditorEntry };

const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'en');

function sortTree(nodes: TreeNode[]): TreeNode[] {
  const folders = nodes.filter((node) => node.kind === 'folder').sort(byName);
  const files = nodes.filter((node) => node.kind === 'file').sort(byName);
  for (const folder of folders) {
    if (folder.kind === 'folder') folder.children = sortTree(folder.children);
  }
  return [...folders, ...files];
}

/** The flat entries as a tree, folders first. A folder is an agent's when `agents/<name>`, a skill's when `skills/<name>`, a workflow's when `workflows/<name>`. */
export function buildTree(entries: readonly EditorEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, Extract<TreeNode, { kind: 'folder' }>>();
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let siblings = root;
    for (let depth = 0; depth < parts.length - 1; depth += 1) {
      const path = parts.slice(0, depth + 1).join('/');
      let folder = folders.get(path);
      if (!folder) {
        folder = {
          kind: 'folder',
          name: parts[depth]!,
          path,
          agent: null,
          skill: null,
          workflow: null,
          children: [],
        };
        folders.set(path, folder);
        siblings.push(folder);
      }
      if (entry.agent !== null && path === `agents/${entry.agent}`) folder.agent = entry.agent;
      if (entry.skill !== null && path === `skills/${entry.skill}`) folder.skill = entry.skill;
      if (entry.workflow !== null && path === `workflows/${entry.workflow}`) {
        folder.workflow = entry.workflow;
      }
      siblings = folder.children;
    }
    siblings.push({ kind: 'file', name: parts[parts.length - 1]!, path: entry.path, entry });
  }
  return sortTree(root);
}

/** The folders that hold `path`, so that a selected file is visible. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, depth) => parts.slice(0, depth + 1).join('/'));
}
