import {
  MODEL_DEFAULT,
  PROVIDER_MODELS,
  PROVIDERS,
  type Provider,
} from '@agentic-studio/contracts';
import { parseEntry, utf8Length } from './front-matter.js';
import {
  AGENT_ENTRY_FILE,
  AGENT_NAME_PATTERN,
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
const WINDOWS_DRIVE = /^[A-Za-z]:/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The first reason a path is refused, or undefined when it is a plain relative path. */
function pathProblem(path: string): 'path_outside_folder' | 'nested_git' | undefined {
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
  if (segments.some((segment) => segment.toLowerCase() === '.git')) return 'nested_git';
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
    if (seen.has(entry.path)) {
      problems.push(problem('duplicate_path', entry.path));
      continue;
    }
    seen.add(entry.path);
    if (entry.kind === 'file') fileEntries.push(entry);
  }

  if (fileEntries.length > MAX_FILES) problems.push(problem('too_many_files', ''));
  let total = 0;
  for (const entry of fileEntries) {
    total += entry.size;
    if (entry.size > MAX_FILE_BYTES) problems.push(problem('file_too_large', entry.path));
  }
  if (total > MAX_FOLDER_BYTES) problems.push(problem('folder_too_large', ''));

  if (!AGENT_NAME_PATTERN.test(folderName)) problems.push(problem('name_invalid', ''));

  const entryFile = fileEntries.find((entry) => entry.path === AGENT_ENTRY_FILE);
  let definition: Omit<AgentDefinition, 'files'> | undefined;
  if (entryFile) {
    definition = judgeEntry(folderName, entryFile, problems);
  } else if (!seen.has(AGENT_ENTRY_FILE)) {
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
    (description.length < 1 ||
      description.length > DESCRIPTION_MAX_LENGTH ||
      /[\r\n]/.test(description))
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
