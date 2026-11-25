import { MAX_QUOTED_LENGTH } from './limits.js';

/** Every reason an agent folder is refused. */
export const PROBLEM_CODES = [
  'entry_missing',
  'entry_unreadable',
  'front_matter_missing',
  'front_matter_malformed',
  'front_matter_too_large',
  'key_missing',
  'key_invalid',
  'provider_unknown',
  'model_unknown',
  'name_invalid',
  'name_mismatch',
  'unknown_key',
  'forbidden_key',
  'instructions_too_large',
  'too_many_files',
  'file_too_large',
  'folder_too_large',
  'path_outside_folder',
  'nested_git',
  'symlink_refused',
  'kind_refused',
  'duplicate_path',
  'size_invalid',
  'cli_config_path',
  'short_name',
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface Problem {
  code: ProblemCode;
  /** The file or folder the problem is about; empty for the folder itself. */
  path: string;
  /** The offending front matter key, when the problem is about one. */
  key?: string;
  /** Fixed wording per code, quoting at most the key or path. Never a value or file content. */
  message: string;
}

/** A path or key is quoted shortened, so a very long one cannot flood a message. */
function quote(text: string): string {
  const shown = text.length > MAX_QUOTED_LENGTH ? `${text.slice(0, MAX_QUOTED_LENGTH)}...` : text;
  return `"${shown}"`;
}

const MESSAGES: Record<ProblemCode, (place: string) => string> = {
  entry_missing: () => 'The agent folder has no AGENT.md entry file.',
  entry_unreadable: () => 'The AGENT.md entry file cannot be read as UTF-8 text.',
  front_matter_missing: () =>
    'AGENT.md must start with front matter between two "---" lines, then the instructions.',
  front_matter_malformed: () =>
    'The front matter is not one YAML mapping of plain keys and values (no list as the root, ' +
    'duplicate keys, aliases or tags).',
  front_matter_too_large: () => 'The front matter is larger than the size limit.',
  key_missing: (key) => `The required key ${key} is missing.`,
  key_invalid: (key) => `The key ${key} has a value of the wrong kind or length.`,
  provider_unknown: () => 'The provider is not one Studio knows.',
  model_unknown: () => "The model is not in that provider's list.",
  name_invalid: () =>
    'The name must be 1 to 64 characters: lower-case letters, digits and "-", starting with a ' +
    'letter or digit.',
  name_mismatch: () => "The name differs from the agent folder's name.",
  unknown_key: (key) => `The key ${key} is not known.`,
  forbidden_key: (key) =>
    `The key ${key} asks for tools, permissions, hooks, MCP servers, memory or isolation, ` +
    'which a definition cannot set.',
  instructions_too_large: () => 'The instructions are larger than the size limit.',
  too_many_files: () => 'The agent folder holds more files than the limit.',
  file_too_large: (path) => `The file ${path} is larger than the size limit.`,
  folder_too_large: () => 'The agent folder is larger in total than the size limit.',
  path_outside_folder: (path) =>
    `The path ${path} is absolute, leaves the folder, or is not a plain relative path.`,
  nested_git: (path) => `The path ${path} is inside a Git directory.`,
  symlink_refused: (path) => `The entry ${path} is a symbolic link.`,
  kind_refused: (path) => `The entry ${path} is neither a file nor a folder.`,
  duplicate_path: (path) =>
    `The path ${path} appears more than once, or differs from another only in case.`,
  size_invalid: (path) => `The size of ${path} is not a whole number of bytes, zero or more.`,
  short_name: (path) =>
    `The path ${path} holds an 8.3 short name (such as PROGRA~1), which another file system ` +
    'may read as a different name.',
  cli_config_path: (path) =>
    `The path ${path} is a hidden file or folder, or a file an agent CLI reads settings, ` +
    'skills or memory from, which a definition cannot carry.',
};

/** Builds a problem; the message quotes only the key (when given) or the path. */
export function problem(code: ProblemCode, path: string, key?: string): Problem {
  const place = quote(key === undefined ? path : key);
  return {
    code,
    path,
    ...(key === undefined ? {} : { key: key.slice(0, MAX_QUOTED_LENGTH) }),
    message: MESSAGES[code](place),
  };
}
