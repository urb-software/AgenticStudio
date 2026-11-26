import { MAX_AGENT_SKILLS, MAX_QUOTED_LENGTH } from './limits.js';

/** The reasons both an agent folder and a skill folder can be refused for. */
export const SHARED_PROBLEM_CODES = [
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
  'name_reserved',
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

export type SharedProblemCode = (typeof SHARED_PROBLEM_CODES)[number];

/** The reasons the skills an agent names refuse it: judged against the skills, not the folder. */
export const AGENT_SKILL_CHECK_CODES = ['skill_missing', 'skill_invalid'] as const;

/** The reasons only an agent folder can be refused for. */
export const AGENT_ONLY_PROBLEM_CODES = [
  'skills_invalid',
  'skill_name_invalid',
  'skill_listed_twice',
  'too_many_skills',
  ...AGENT_SKILL_CHECK_CODES,
] as const;

/** Every reason an agent folder is refused. */
export const PROBLEM_CODES = [...SHARED_PROBLEM_CODES, ...AGENT_ONLY_PROBLEM_CODES] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** The reasons only a skill folder can be refused for. */
export const SKILL_ONLY_PROBLEM_CODES = ['shell_line'] as const;

/** Every reason a skill folder is refused: the shared ones and those only a skill has. */
export const SKILL_PROBLEM_CODES = [...SHARED_PROBLEM_CODES, ...SKILL_ONLY_PROBLEM_CODES] as const;

export type SkillProblemCode = (typeof SKILL_PROBLEM_CODES)[number];

export interface Problem<Code extends string = ProblemCode> {
  code: Code;
  /** The file or folder the problem is about; empty for the folder itself. */
  path: string;
  /** The offending front matter key; for the four skill-name reasons, the skill name. */
  key?: string;
  /** Fixed wording per code, quoting at most the key, a skill name or the path; no other value. */
  message: string;
}

/** A path or key is quoted shortened, so a very long one cannot flood a message. */
function quote(text: string): string {
  const shown = text.length > MAX_QUOTED_LENGTH ? `${text.slice(0, MAX_QUOTED_LENGTH)}...` : text;
  return `"${shown}"`;
}

/** What a message calls the folder and its entry file. */
export interface Subject {
  noun: 'agent' | 'skill';
  entry: string;
}
export const AGENT_SUBJECT: Subject = { noun: 'agent', entry: 'AGENT.md' };
export const SKILL_SUBJECT: Subject = { noun: 'skill', entry: 'SKILL.md' };

const MESSAGES: Record<
  ProblemCode | SkillProblemCode,
  (place: string, subject: Subject) => string
> = {
  entry_missing: (_, s) => `The ${s.noun} folder has no ${s.entry} entry file.`,
  entry_unreadable: (place, s) =>
    s.noun === 'agent'
      ? 'The AGENT.md entry file cannot be read as UTF-8 text.'
      : `The file ${place} cannot be read as UTF-8 text.`,
  front_matter_missing: (_, s) =>
    `${s.entry} must start with front matter between two "---" lines, then the instructions.`,
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
  name_reserved: () => 'The name is reserved by Studio.',
  name_mismatch: (_, s) => `The name differs from the ${s.noun} folder's name.`,
  unknown_key: (key) => `The key ${key} is not known.`,
  forbidden_key: (key) =>
    `The key ${key} asks for tools, permissions, hooks, MCP servers, memory or isolation, ` +
    'which a definition cannot set.',
  instructions_too_large: () => 'The instructions are larger than the size limit.',
  too_many_files: (_, s) => `The ${s.noun} folder holds more files than the limit.`,
  file_too_large: (path) => `The file ${path} is larger than the size limit.`,
  folder_too_large: (_, s) => `The ${s.noun} folder is larger in total than the size limit.`,
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
  cli_config_path: (path, s) =>
    `The path ${path} is a hidden file or folder, or a file ` +
    `${s.noun === 'agent' ? 'an agent CLI' : 'a CLI'} reads settings, skills or memory from, ` +
    'which a definition cannot carry.',
  shell_line: (path) => `The file ${path} holds an inline shell line, which a skill cannot carry.`,
  skills_invalid: () => 'The key skills must be a list of skill names.',
  skill_name_invalid: (name) =>
    `The skill name ${name} must be 1 to 64 characters: lower-case letters, digits and "-", ` +
    'starting with a letter or digit.',
  skill_listed_twice: (name) => `The skill ${name} is listed more than once.`,
  too_many_skills: () => `An agent names at most ${MAX_AGENT_SKILLS} skills.`,
  skill_missing: (name) => `The skill ${name} does not exist.`,
  skill_invalid: (name) => `The skill ${name} is not valid.`,
};

function build<Code extends ProblemCode | SkillProblemCode>(
  code: Code,
  path: string,
  key: string | undefined,
  subject: Subject,
): Problem<Code> {
  const place = quote(key === undefined ? path : key);
  return {
    code,
    path,
    ...(key === undefined ? {} : { key: key.slice(0, MAX_QUOTED_LENGTH) }),
    message: MESSAGES[code](place, subject),
  };
}

/** Builds a problem; the message quotes only the key (when given) or the path. */
export function problem(
  code: ProblemCode,
  path: string,
  key?: string,
  subject: Subject = AGENT_SUBJECT,
): Problem {
  return build(code, path, key, subject);
}

/** The same for a skill folder, which has the reasons of PROBLEM_CODES and more. */
export function skillProblem(
  code: SkillProblemCode,
  path: string,
  key?: string,
): Problem<SkillProblemCode> {
  return build(code, path, key, SKILL_SUBJECT);
}
