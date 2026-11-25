import {
  MODEL_DEFAULT,
  PROVIDER_MODELS,
  PROVIDERS,
  type Provider,
} from '@agentic-studio/contracts/providers';
import { parseEntry, utf8Length } from './front-matter.js';
import {
  AGENT_ENTRY_FILE,
  AGENT_NAME_PATTERN,
  CLI_DISCOVERED_FILES,
  DESCRIPTION_MAX_LENGTH,
  FORBIDDEN_KEYS,
  KNOWN_KEYS,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  MAX_INSTRUCTIONS_BYTES,
} from './limits.js';
import { problem, type Problem } from './problems.js';

/** One item of a folder, as a caller read it: no file system is touched here. */
export interface AgentEntry {
  /** Relative to the agent folder, with `/` separators. */
  path: string;
  /** `file`, `directory`, `symlink`, or anything else a tree can hold (for example `submodule`). */
  kind: string;
  /** Size in bytes (0 for a folder). */
  size: number;
  /** The text of a file, when the caller read it as UTF-8. Only the entry file needs it. */
  content?: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  provider: Provider;
  model: string;
  /**
   * The Markdown after the front matter. Consumers hand a CLI only this and the other parsed
   * fields, never the raw AGENT.md: a CLI's own parser may cut the front matter elsewhere.
   */
  instructions: string;
  /** Every file of the folder, the entry file included. */
  files: { path: string; size: number }[];
}

export type AgentFolderResult =
  { ok: true; definition: AgentDefinition } | { ok: false; problems: Problem[] };

const normalise = (key: string): string =>
  key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
const FORBIDDEN = new Set(FORBIDDEN_KEYS.map(normalise));
const KNOWN = new Set<string>(KNOWN_KEYS);
// Controls, NEL and the Unicode line and paragraph separators: no second line, no escape codes.
const DESCRIPTION_FORBIDDEN = /[\p{Cc}\u0085\u2028\u2029]/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

// Code points that some file systems ignore when they compare names (a zero-width joiner, a
// bidirectional mark), so `.g<ZWNJ>it` is `.git` there.
const IGNORED_IN_NAMES = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
const SHORT_NAME = /~\d/;
const CLI_FILES = new Set(CLI_DISCOVERED_FILES.map((name) => name.toLowerCase()));

/** True for a segment that Git, or a file system on an operator's machine, reads as `.git`. */
function isGitName(segment: string): boolean {
  const plain = segment
    .replace(IGNORED_IN_NAMES, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
  return plain === '.git' || /^git~\d+$/.test(plain);
}

type PathCode = 'path_outside_folder' | 'nested_git' | 'cli_config_path';

/** The first reason a path is refused, or undefined when it is a plain relative path. */
function pathProblem(path: string): PathCode | undefined {
  const segments = path.split('/');
  if (
    path.startsWith('/') ||
    path.includes('\\') ||
    WINDOWS_DRIVE.test(path) ||
    CONTROL.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return 'path_outside_folder';
  }
  if (segments.some(isGitName)) return 'nested_git';
  // An 8.3 short name (`PROGRA~1`) is another spelling of a longer name on some file systems.
  if (segments.some((segment) => SHORT_NAME.test(segment))) return 'path_outside_folder';
  const base = (segments[segments.length - 1] as string).toLowerCase();
  if (segments.some((segment) => segment.startsWith('.')) || CLI_FILES.has(base)) {
    return 'cli_config_path';
  }
  return undefined;
}

/** Judges the entries of one agent folder. Pure: reads nothing, starts nothing. */
export function validateAgentFolder(
  folderName: string,
  entries: readonly AgentEntry[],
): AgentFolderResult {
  const problems: Problem[] = [];
  const fileEntries: AgentEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.path === '' && entry.kind === 'directory') continue;
    const bad = pathProblem(entry.path);
    if (bad) {
      problems.push(problem(bad, entry.path));
      continue;
    }
    if (entry.kind === 'symlink') {
      problems.push(problem('symlink_refused', entry.path));
      continue;
    }
    if (entry.kind !== 'file' && entry.kind !== 'directory') {
      problems.push(problem('kind_refused', entry.path));
      continue;
    }
    if (seen.has(entry.path.toLowerCase())) {
      problems.push(problem('duplicate_path', entry.path));
      continue;
    }
    seen.add(entry.path.toLowerCase());
    if (entry.kind === 'file') fileEntries.push(entry);
  }

  if (fileEntries.length > MAX_FILES) problems.push(problem('too_many_files', ''));
  let total = 0;
  for (const entry of fileEntries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      problems.push(problem('size_invalid', entry.path));
      continue;
    }
    // The entry file is also measured by its text, so a declared size cannot hide a large file.
    const size =
      entry.path === AGENT_ENTRY_FILE && entry.content !== undefined
        ? Math.max(entry.size, utf8Length(entry.content))
        : entry.size;
    total += size;
    if (size > MAX_FILE_BYTES) problems.push(problem('file_too_large', entry.path));
  }
  if (total > MAX_FOLDER_BYTES) problems.push(problem('folder_too_large', ''));

  if (!AGENT_NAME_PATTERN.test(folderName)) problems.push(problem('name_invalid', ''));

  const entryFile = fileEntries.find((entry) => entry.path === AGENT_ENTRY_FILE);
  let definition: Omit<AgentDefinition, 'files'> | undefined;
  if (entryFile) {
    definition = judgeEntry(folderName, entryFile, problems);
  } else if (!problems.some((item) => item.path === AGENT_ENTRY_FILE)) {
    problems.push(problem('entry_missing', AGENT_ENTRY_FILE));
  }

  // A refusal always carries a reason.
  if (problems.length === 0 && !definition) {
    problems.push(problem('entry_missing', AGENT_ENTRY_FILE));
  }
  if (problems.length > 0 || !definition) return { ok: false, problems };
  return {
    ok: true,
    definition: {
      ...definition,
      files: fileEntries.map(({ path, size }) => ({ path, size })),
    },
  };
}

function judgeEntry(
  folderName: string,
  entry: AgentEntry,
  problems: Problem[],
): Omit<AgentDefinition, 'files'> | undefined {
  const path = AGENT_ENTRY_FILE;
  const text = entry.content;
  if (text === undefined || text.includes('�') || text.includes('\u0000')) {
    problems.push(problem('entry_unreadable', path));
    return undefined;
  }
  const parsed = parseEntry(text);
  if (parsed.status !== 'ok') {
    const code = {
      missing: 'front_matter_missing',
      malformed: 'front_matter_malformed',
      too_large: 'front_matter_too_large',
    } as const;
    problems.push(problem(code[parsed.status], path));
    return undefined;
  }

  const before = problems.length;
  const { values, instructions } = parsed;

  for (const key of Object.keys(values)) {
    if (FORBIDDEN.has(normalise(key))) problems.push(problem('forbidden_key', path, key));
    else if (!KNOWN.has(key)) problems.push(problem('unknown_key', path, key));
  }
  if (utf8Length(instructions) > MAX_INSTRUCTIONS_BYTES) {
    problems.push(problem('instructions_too_large', path));
  }

  const required = (key: string): string | undefined => {
    const value = values[key];
    if (value === undefined || value === null) {
      problems.push(problem('key_missing', path, key));
      return undefined;
    }
    if (typeof value !== 'string') {
      problems.push(problem('key_invalid', path, key));
      return undefined;
    }
    return value;
  };

  const name = required('name');
  if (name !== undefined) {
    if (!AGENT_NAME_PATTERN.test(name)) problems.push(problem('name_invalid', path));
    else if (name !== folderName) problems.push(problem('name_mismatch', path));
  }

  const description = required('description');
  if (
    description !== undefined &&
    (description.trim() === '' ||
      description.length > DESCRIPTION_MAX_LENGTH ||
      DESCRIPTION_FORBIDDEN.test(description))
  ) {
    problems.push(problem('key_invalid', path, 'description'));
  }

  const providerText = required('provider');
  const provider = (PROVIDERS as readonly string[]).includes(providerText ?? '')
    ? (providerText as Provider)
    : undefined;
  if (providerText !== undefined && provider === undefined) {
    problems.push(problem('provider_unknown', path));
  }

  let model: string = MODEL_DEFAULT;
  const modelValue = values['model'];
  if (modelValue !== undefined && modelValue !== null) {
    if (typeof modelValue !== 'string') {
      problems.push(problem('key_invalid', path, 'model'));
    } else {
      model = modelValue;
      const listed = provider !== undefined && PROVIDER_MODELS[provider].some((m) => m === model);
      if (provider !== undefined && !listed) problems.push(problem('model_unknown', path));
    }
  }

  if (problems.length > before || name === undefined || description === undefined || !provider) {
    return undefined;
  }
  return { name, description, provider, model, instructions };
}
