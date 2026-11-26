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
  MARKDOWN_FILE,
  MAX_INSTRUCTIONS_BYTES,
  RESERVED_AGENT_NAMES,
  SHELL_LINE,
  SKILL_CLI_DISCOVERED_FILES,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_ENTRY_FILE,
  SKILL_FORBIDDEN_KEYS,
  SKILL_KNOWN_KEYS,
  SKILL_METADATA_MAX_ENTRIES,
  SKILL_METADATA_MAX_KEY_LENGTH,
  SKILL_METADATA_MAX_VALUE_LENGTH,
  SKILL_TEXT_MAX_LENGTH,
} from './limits.js';
import {
  AGENT_SUBJECT,
  problem as makeProblem,
  skillProblem,
  SKILL_SUBJECT,
  type Problem,
  type ProblemCode,
  type SkillProblemCode,
  type Subject,
} from './problems.js';

const problem = (code: ProblemCode, path: string, key?: string): Problem =>
  makeProblem(code, path, key, AGENT_SUBJECT);

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

type SkillProblem = Problem<SkillProblemCode>;

export interface SkillDefinition {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  /** The Markdown after the front matter; consumers never hand a CLI the raw SKILL.md. */
  instructions: string;
  /** Every file of the folder, the entry file included. */
  files: { path: string; size: number }[];
}

export type SkillFolderResult =
  { ok: true; definition: SkillDefinition } | { ok: false; problems: SkillProblem[] };

/** What differs between judging an agent folder and a skill folder. */
interface Kind {
  subject: Subject;
  entryFile: string;
  cliFiles: ReadonlySet<string>;
}

export type AgentFolderResult =
  { ok: true; definition: AgentDefinition } | { ok: false; problems: Problem[] };

const normalise = (key: string): string =>
  key.toLowerCase().replaceAll('-', '').replaceAll('_', '');
const FORBIDDEN = new Set(FORBIDDEN_KEYS.map(normalise));
const SKILL_FORBIDDEN = new Set([...FORBIDDEN_KEYS, ...SKILL_FORBIDDEN_KEYS].map(normalise));
const SKILL_KNOWN = new Set<string>(SKILL_KNOWN_KEYS);
const KNOWN = new Set<string>(KNOWN_KEYS);
// Controls, NEL and the Unicode line and paragraph separators: no second line, no escape codes.
const DESCRIPTION_FORBIDDEN = /[\p{Cc}\u0085\u2028\u2029]/u;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

// Code points that some file systems ignore when they compare names (a zero-width joiner, a
// bidirectional mark), so `.g<ZWNJ>it` is `.git` there.
const IGNORED_IN_NAMES = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
const SHORT_NAME = /^[^.~]{1,6}~\d+(\.[^.]{0,3})?$/i;
const lower = (names: readonly string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));
const CLI_FILES = lower(CLI_DISCOVERED_FILES);
const SKILL_KIND: Kind = {
  subject: SKILL_SUBJECT,
  entryFile: SKILL_ENTRY_FILE,
  cliFiles: lower(SKILL_CLI_DISCOVERED_FILES),
};
const AGENT_KIND: Kind = {
  subject: AGENT_SUBJECT,
  entryFile: AGENT_ENTRY_FILE,
  cliFiles: CLI_FILES,
};

/** The text without its trailing dots and spaces, cut by a scan, not a pattern that can backtrack. */
function trimTrailingDotsAndSpaces(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '.' || text[end - 1] === ' ')) end -= 1;
  return text.slice(0, end);
}

/** A name as another file system may compare it: no ignored characters or trailing dots. */
function plainName(segment: string): string {
  return trimTrailingDotsAndSpaces(segment.replace(IGNORED_IN_NAMES, '')).toLowerCase();
}

/** True for a segment that Git, or a file system on an operator's machine, reads as `.git`. */
function isGitName(segment: string): boolean {
  const plain = plainName(segment);
  return plain === '.git' || /^git~\d+$/.test(plain);
}

type PathCode = 'path_outside_folder' | 'nested_git' | 'cli_config_path' | 'short_name';

/** The first reason a path is refused, or undefined when it is a plain relative path. */
function pathProblem(path: string, kind: Kind): PathCode | undefined {
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
  if (segments.some((segment) => SHORT_NAME.test(segment))) return 'short_name';
  const plain = segments.map(plainName);
  const base = plain[plain.length - 1] as string;
  const hidden = (segment: string) => segment.startsWith('.');
  // The entry file at the folder root is the one place its own name is allowed.
  const isEntry = path === kind.entryFile;
  if (segments.some(hidden) || plain.some(hidden) || (!isEntry && kind.cliFiles.has(base))) {
    return 'cli_config_path';
  }
  return undefined;
}

/** The files of a folder, as kept after the path, kind and duplicate checks. */
interface JudgedEntries {
  problems: Problem[];
  fileEntries: AgentEntry[];
}

function judgeEntries(entries: readonly AgentEntry[], kind: Kind): JudgedEntries {
  const problem = (code: ProblemCode, path: string, key?: string): Problem =>
    makeProblem(code, path, key, kind.subject);
  const problems: Problem[] = [];
  const fileEntries: AgentEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.path === '' && entry.kind === 'directory') continue;
    const bad = pathProblem(entry.path, kind);
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
      entry.path === kind.entryFile && entry.content !== undefined
        ? Math.max(entry.size, utf8Length(entry.content))
        : entry.size;
    total += size;
    if (size > MAX_FILE_BYTES) problems.push(problem('file_too_large', entry.path));
  }
  if (total > MAX_FOLDER_BYTES) problems.push(problem('folder_too_large', ''));
  return { problems, fileEntries };
}

/**
 * Judges the files of a folder by the path, kind, duplicate and size rules alone: no entry file
 * and no name are needed. What the agent worker checks again before it writes a hand-over.
 */
export function validateAgentFiles(entries: readonly AgentEntry[]): Problem[] {
  return judgeEntries(entries, AGENT_KIND).problems;
}

/** Judges the entries of one agent folder. Pure: reads nothing, starts nothing. */
export function validateAgentFolder(
  folderName: string,
  entries: readonly AgentEntry[],
): AgentFolderResult {
  const { problems, fileEntries } = judgeEntries(entries, AGENT_KIND);

  if (!AGENT_NAME_PATTERN.test(folderName)) problems.push(problem('name_invalid', ''));
  else if ((RESERVED_AGENT_NAMES as readonly string[]).includes(folderName)) {
    problems.push(problem('name_reserved', ''));
  }

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
    // An entry file over the size limit is never read: the size problem already says it.
    const tooLarge = problems.some((item) => item.code === 'file_too_large' && item.path === path);
    if (!tooLarge) problems.push(problem('entry_unreadable', path));
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

/** True when the text is missing, is not UTF-8 or holds a NUL: it cannot be judged as text. */
function unreadable(text: string | undefined): boolean {
  return text === undefined || text.includes('�') || text.includes('\u0000');
}

/** Judges the entries of one skill folder. Pure: reads nothing, starts nothing. */
export function validateSkillFolder(
  folderName: string,
  entries: readonly AgentEntry[],
): SkillFolderResult {
  const { problems: shared, fileEntries } = judgeEntries(entries, SKILL_KIND);
  const problems: SkillProblem[] = [...shared];
  const tooLarge = (path: string) =>
    problems.some((item) => item.code === 'file_too_large' && item.path === path);

  if (!AGENT_NAME_PATTERN.test(folderName)) problems.push(skillProblem('name_invalid', ''));

  // Every Markdown file is read for shell lines; one that cannot be read cannot be trusted.
  for (const entry of fileEntries) {
    if (entry.path === SKILL_ENTRY_FILE || !MARKDOWN_FILE.test(entry.path)) continue;
    if (unreadable(entry.content)) {
      if (!tooLarge(entry.path)) problems.push(skillProblem('entry_unreadable', entry.path));
    } else if (SHELL_LINE.test(entry.content as string)) {
      problems.push(skillProblem('shell_line', entry.path));
    }
  }

  const entryFile = fileEntries.find((entry) => entry.path === SKILL_ENTRY_FILE);
  let definition: Omit<SkillDefinition, 'files'> | undefined;
  if (entryFile) {
    definition = judgeSkillEntry(folderName, entryFile, problems, tooLarge(SKILL_ENTRY_FILE));
  } else if (!problems.some((item) => item.path === SKILL_ENTRY_FILE)) {
    problems.push(skillProblem('entry_missing', SKILL_ENTRY_FILE));
  }

  // A refusal always carries a reason.
  if (problems.length === 0 && !definition) {
    problems.push(skillProblem('entry_missing', SKILL_ENTRY_FILE));
  }
  if (problems.length > 0 || !definition) return { ok: false, problems };
  return {
    ok: true,
    definition: { ...definition, files: fileEntries.map(({ path, size }) => ({ path, size })) },
  };
}

/** One line of 1 to `max` characters, with no control character. */
function oneLine(value: string, max: number): boolean {
  return value.trim() !== '' && value.length <= max && !DESCRIPTION_FORBIDDEN.test(value);
}

function judgeSkillEntry(
  folderName: string,
  entry: AgentEntry,
  problems: SkillProblem[],
  sizeRefused: boolean,
): Omit<SkillDefinition, 'files'> | undefined {
  const path = SKILL_ENTRY_FILE;
  const text = entry.content;
  if (text === undefined || unreadable(text)) {
    // An entry file over the size limit is never read: the size problem already says it.
    if (!sizeRefused) problems.push(skillProblem('entry_unreadable', path));
    return undefined;
  }
  if (SHELL_LINE.test(text)) problems.push(skillProblem('shell_line', path));
  const parsed = parseEntry(text);
  if (parsed.status !== 'ok') {
    const code = {
      missing: 'front_matter_missing',
      malformed: 'front_matter_malformed',
      too_large: 'front_matter_too_large',
    } as const;
    problems.push(skillProblem(code[parsed.status], path));
    return undefined;
  }

  const before = problems.length;
  const { values, instructions } = parsed;

  for (const key of Object.keys(values)) {
    if (SKILL_FORBIDDEN.has(normalise(key))) {
      problems.push(skillProblem('forbidden_key', path, key));
    } else if (!SKILL_KNOWN.has(key)) {
      problems.push(skillProblem('unknown_key', path, key));
    }
  }
  if (utf8Length(instructions) > MAX_INSTRUCTIONS_BYTES) {
    problems.push(skillProblem('instructions_too_large', path));
  }

  const present = (key: string): unknown => {
    const value = values[key];
    return value === null ? undefined : value;
  };
  const textValue = (key: string, required: boolean, max: number): string | undefined => {
    const value = present(key);
    if (value === undefined) {
      if (required) problems.push(skillProblem('key_missing', path, key));
      return undefined;
    }
    if (typeof value !== 'string' || (key !== 'name' && !oneLine(value, max))) {
      problems.push(skillProblem('key_invalid', path, key));
      return undefined;
    }
    return value;
  };

  const name = textValue('name', true, 0);
  if (name !== undefined) {
    if (!AGENT_NAME_PATTERN.test(name)) problems.push(skillProblem('name_invalid', path));
    else if (name !== folderName) problems.push(skillProblem('name_mismatch', path));
  }
  const description = textValue('description', true, SKILL_DESCRIPTION_MAX_LENGTH);
  const license = textValue('license', false, SKILL_TEXT_MAX_LENGTH);
  const compatibility = textValue('compatibility', false, SKILL_TEXT_MAX_LENGTH);

  let metadata: Record<string, string> | undefined;
  const rawMetadata = present('metadata');
  if (rawMetadata !== undefined) {
    const items =
      typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)
        ? Object.entries(rawMetadata as Record<string, unknown>)
        : undefined;
    const good =
      items !== undefined &&
      items.length <= SKILL_METADATA_MAX_ENTRIES &&
      items.every(
        ([key, value]) =>
          key.length >= 1 &&
          key.length <= SKILL_METADATA_MAX_KEY_LENGTH &&
          !DESCRIPTION_FORBIDDEN.test(key) &&
          typeof value === 'string' &&
          value.length <= SKILL_METADATA_MAX_VALUE_LENGTH &&
          !DESCRIPTION_FORBIDDEN.test(value),
      );
    if (good) metadata = Object.fromEntries(items as [string, string][]);
    else problems.push(skillProblem('key_invalid', path, 'metadata'));
  }

  if (problems.length > before || name === undefined || description === undefined) {
    return undefined;
  }
  return {
    name,
    description,
    ...(license === undefined ? {} : { license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(metadata === undefined ? {} : { metadata }),
    instructions,
  };
}
