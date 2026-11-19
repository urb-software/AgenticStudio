import { mkdir, rm, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { formatValue, readFrontmatter } from './frontmatter.js';

/**
 * The repository's skills and subagents as a per-Run plugin (`--plugin-dir`, prefix `repo:`), built
 * from Git at the Run's start commit and sanitized: they are untrusted guidance like `CLAUDE.md`,
 * so nothing that grants a tool, runs code or changes permissions reaches the CLI.
 */

export const REPO_PLUGIN_LIMITS = {
  skills: 50,
  agents: 50,
  fileBytes: 64 * 1024,
  totalBytes: 1024 * 1024,
} as const;

/** Skill and subagent names the CLI may see. */
export const REPO_PLUGIN_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Frontmatter keys kept; every other key is dropped and named in the log. */
export const SKILL_KEYS: readonly string[] = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'disable-model-invocation',
  'user-invocable',
  'context',
  'agent',
  'model',
  'effort',
];
export const AGENT_KEYS: readonly string[] = [
  'name',
  'description',
  'tools',
  'disallowedTools',
  'model',
  'maxTurns',
  'skills',
  'effort',
];

const SKILLS_DIR = '.claude/skills';
const AGENTS_DIR = '.claude/agents';

/** One entry of the start commit's tree under the skill and agent folders. */
export interface TreeEntry {
  /** Git file mode, e.g. `100644`, `120000` (symbolic link), `160000` (gitlink). */
  mode: string;
  sha: string;
  size: number;
  path: string;
}

/** The repository at the Run's start commit. */
export interface RepositoryTree {
  /** Every entry under `.claude/skills` and `.claude/agents`, recursively, in path order. */
  list(): Promise<TreeEntry[]>;
  /** A blob's text. */
  blob(sha: string): Promise<string>;
}

export interface RepoPlugin {
  /** The plugin directory, or `null` when there is nothing to pass to the CLI. */
  dir: string | null;
  /** What was left out or dropped, for the Run's log. Never file content. */
  notices: string[];
}

/** Parses `git ls-tree -r -l -z` output. */
export function parseTreeListing(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t([\s\S]+)$/.exec(record);
    if (!match) continue;
    entries.push({
      mode: match[1]!,
      sha: match[3]!,
      size: match[4] === '-' ? 0 : Number(match[4]),
      path: match[5]!,
    });
  }
  return entries;
}

/**
 * The CLI runs shell for `` !` `` and for a fence opened with ```! anywhere in the text; the `$`
 * forms are refused too, as the start of syntax built from arguments at run time.
 */
const SHELL_LINE = /!`|```!|~~~!|```\$|~~~\$|!\$/;

/** Entries a skill may hold, and entries looked at in total, before the rest is left out. */
const MAX_SKILL_ENTRIES = 200;
const MAX_EXAMINED = 2000;
const MAX_NOTICES = 100;

/** Largest `ls-tree` listing (bytes) the worker keeps; a longer one is cut and refused. */
export const TREE_LISTING_MAX_BYTES = 1024 * 1024;

/** Thrown by {@link RepositoryTree.list} when the listing did not fit. */
export class TreeListingTooLargeError extends Error {}

interface Budget {
  examined: number;
  readBytes: number;
}

interface Rendered {
  text: string;
  dropped: string[];
}

/** The file with only the allowlisted frontmatter keys, `name` forced to the folder or file name. */
function render(
  text: string,
  allowed: readonly string[],
  name: string,
): Rendered | { error: string } {
  const parsed = readFrontmatter(text);
  if ('error' in parsed) return parsed;
  const lines = [`name: ${formatValue(name)}`];
  const dropped: string[] = [];
  for (const [key, value] of parsed.entries) {
    if (key === 'name') continue;
    if (!allowed.includes(key)) dropped.push(key);
    else if (value === undefined || value === null) return { error: `invalid value for ${key}` };
    else lines.push(`${key}: ${formatValue(value)}`);
  }
  return { text: ['---', ...lines, '---', ''].join('\n') + parsed.body, dropped };
}

function isText(text: string): boolean {
  return !text.includes('\0') && !text.includes('�');
}

interface Planned {
  files: { path: string; text: string }[];
  bytes: number;
}

/** Everything a skill folder holds, or the reason the skill is left out. */
async function planSkill(
  name: string,
  entries: readonly TreeEntry[],
  tree: RepositoryTree,
  notices: string[],
  budget: Budget,
): Promise<Planned | string> {
  const files: Planned['files'] = [];
  let bytes = 0;
  let sawSkillFile = false;
  if (entries.length > MAX_SKILL_ENTRIES) return `more than ${MAX_SKILL_ENTRIES} files`;
  for (const entry of entries) {
    budget.examined += 1;
    if (budget.examined > MAX_EXAMINED) return 'too many entries in the repository';
    const relative = entry.path.slice(`${SKILLS_DIR}/${name}/`.length);
    const segments = relative.split('/');
    if (segments.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) {
      continue;
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      if (relative === 'SKILL.md') return 'SKILL.md is not a regular file';
      notices.push(`Left out ${entry.path} (not a regular file).`);
      continue;
    }
    if (entry.size > REPO_PLUGIN_LIMITS.fileBytes) {
      if (relative === 'SKILL.md') return 'SKILL.md is over the size limit';
      notices.push(`Left out ${entry.path} (over ${REPO_PLUGIN_LIMITS.fileBytes / 1024} KiB).`);
      continue;
    }
    if (budget.readBytes + entry.size > REPO_PLUGIN_LIMITS.totalBytes) {
      return `the plugin reached ${REPO_PLUGIN_LIMITS.totalBytes / 1024} KiB`;
    }
    budget.readBytes += entry.size;
    const text = await tree.blob(entry.sha);
    if (!isText(text)) {
      if (relative === 'SKILL.md') return 'SKILL.md is not text';
      notices.push(`Left out ${entry.path} (not text).`);
      continue;
    }
    if (SHELL_LINE.test(text)) return `${entry.path} contains a shell line`;
    if (relative === 'SKILL.md') {
      sawSkillFile = true;
      const rendered = render(text, SKILL_KEYS, name);
      if ('error' in rendered) return rendered.error;
      if (SHELL_LINE.test(rendered.text)) return `${entry.path} contains a shell line`;
      if (rendered.dropped.length > 0) {
        notices.push(`Dropped frontmatter keys of skill ${name}: ${rendered.dropped.join(', ')}.`);
      }
      files.push({ path: relative, text: rendered.text });
      bytes += Buffer.byteLength(rendered.text);
    } else {
      files.push({ path: relative, text });
      bytes += Buffer.byteLength(text);
    }
  }
  return sawSkillFile ? { files, bytes } : 'no SKILL.md';
}

/**
 * Replaces `<dir>` with the plugin built from the repository's skills and subagents at the start
 * commit. The directory is removed first (a link is removed, never followed) and written fresh.
 */
export async function prepareRepoPlugin(dir: string, tree: RepositoryTree): Promise<RepoPlugin> {
  await rm(dir, { recursive: true, force: true });
  const notices: string[] = [];
  const result = await buildPlugin(dir, tree, notices);
  if (notices.length > MAX_NOTICES) {
    const more = notices.length - MAX_NOTICES;
    notices.length = MAX_NOTICES;
    notices.push(`${more} further notices left out.`);
  }
  return result;
}

async function buildPlugin(
  dir: string,
  tree: RepositoryTree,
  notices: string[],
): Promise<RepoPlugin> {
  const budget: Budget = { examined: 0, readBytes: 0 };
  let entries: TreeEntry[];
  try {
    entries = await tree.list();
  } catch (error) {
    if (!(error instanceof TreeListingTooLargeError)) throw error;
    notices.push('Left out all repository skills and agents: the file listing is too large.');
    return { dir: null, notices };
  }
  const skills = new Map<string, TreeEntry[]>();
  const agents: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.path.startsWith(`${SKILLS_DIR}/`)) {
      const name = entry.path.slice(SKILLS_DIR.length + 1).split('/')[0]!;
      if (entry.path.slice(SKILLS_DIR.length + 1) === name) continue;
      skills.set(name, [...(skills.get(name) ?? []), entry]);
    } else if (entry.path.startsWith(`${AGENTS_DIR}/`)) {
      if (!entry.path.slice(AGENTS_DIR.length + 1).includes('/')) agents.push(entry);
    }
  }

  let total = 0;
  const written: { path: string; text: string }[] = [];
  const room = (bytes: number, what: string): boolean => {
    if (total + bytes > REPO_PLUGIN_LIMITS.totalBytes) {
      notices.push(
        `Left out ${what}: the plugin reached ${REPO_PLUGIN_LIMITS.totalBytes / 1024} KiB.`,
      );
      return false;
    }
    total += bytes;
    return true;
  };

  let skillCount = 0;
  for (const [name, group] of skills) {
    if (!REPO_PLUGIN_NAME.test(name)) {
      notices.push(`Left out skill ${JSON.stringify(name)} (invalid name).`);
      continue;
    }
    if (skillCount >= REPO_PLUGIN_LIMITS.skills) {
      notices.push(`Left out skill ${name}: more than ${REPO_PLUGIN_LIMITS.skills} skills.`);
      continue;
    }
    const planned = await planSkill(name, group, tree, notices, budget);
    if (typeof planned === 'string') {
      notices.push(`Left out skill ${name}: ${planned}.`);
      continue;
    }
    if (!room(planned.bytes, `skill ${name}`)) continue;
    skillCount += 1;
    for (const file of planned.files) {
      written.push({ path: posix.join('skills', name, file.path), text: file.text });
    }
  }

  let agentCount = 0;
  for (const entry of agents) {
    const file = entry.path.slice(AGENTS_DIR.length + 1);
    if (!file.endsWith('.md')) continue;
    const name = file.slice(0, -'.md'.length);
    if (!REPO_PLUGIN_NAME.test(name)) {
      notices.push(`Left out agent ${JSON.stringify(name)} (invalid name).`);
      continue;
    }
    if (entry.mode !== '100644' && entry.mode !== '100755') {
      notices.push(`Left out agent ${name}: not a regular file.`);
      continue;
    }
    if (agentCount >= REPO_PLUGIN_LIMITS.agents) {
      notices.push(`Left out agent ${name}: more than ${REPO_PLUGIN_LIMITS.agents} agents.`);
      continue;
    }
    if (entry.size > REPO_PLUGIN_LIMITS.fileBytes) {
      notices.push(`Left out agent ${name}: over ${REPO_PLUGIN_LIMITS.fileBytes / 1024} KiB.`);
      continue;
    }
    budget.examined += 1;
    if (budget.examined > MAX_EXAMINED) {
      notices.push(`Left out agent ${name}: too many entries in the repository.`);
      continue;
    }
    if (budget.readBytes + entry.size > REPO_PLUGIN_LIMITS.totalBytes) {
      notices.push(
        `Left out agent ${name}: the plugin reached ${REPO_PLUGIN_LIMITS.totalBytes / 1024} KiB.`,
      );
      continue;
    }
    budget.readBytes += entry.size;
    const text = await tree.blob(entry.sha);
    if (!isText(text)) {
      notices.push(`Left out agent ${name}: not text.`);
      continue;
    }
    const rendered = render(text, AGENT_KEYS, name);
    if ('error' in rendered) {
      notices.push(`Left out agent ${name}: ${rendered.error}.`);
      continue;
    }
    if (SHELL_LINE.test(text) || SHELL_LINE.test(rendered.text)) {
      notices.push(`Left out agent ${name}: contains a shell line.`);
      continue;
    }
    if (!room(Buffer.byteLength(rendered.text), `agent ${name}`)) continue;
    if (rendered.dropped.length > 0) {
      notices.push(`Dropped frontmatter keys of agent ${name}: ${rendered.dropped.join(', ')}.`);
    }
    agentCount += 1;
    written.push({ path: posix.join('agents', `${name}.md`), text: rendered.text });
  }

  if (written.length === 0) return { dir: null, notices };
  await mkdir(posix.join(dir, '.claude-plugin'), { recursive: true, mode: 0o700 });
  await writeFile(posix.join(dir, '.claude-plugin', 'plugin.json'), '{"name":"repo"}\n', {
    mode: 0o600,
  });
  for (const file of written) {
    const target = posix.join(dir, file.path);
    await mkdir(posix.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.text, { mode: 0o600, flag: 'wx' });
  }
  return { dir, notices };
}
