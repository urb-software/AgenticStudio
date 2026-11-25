import type { AgentEntry } from '../index.js';

/** A file entry whose size is the byte length of its text. */
export function file(path: string, content: string): AgentEntry {
  return { path, kind: 'file', size: new TextEncoder().encode(content).length, content };
}

/** A binary file: only a size, no content. */
export function binary(path: string, size: number): AgentEntry {
  return { path, kind: 'file', size };
}

export function entryFile(front: string, instructions = 'Do the work.\n'): AgentEntry {
  return file('AGENT.md', `---\n${front}\n---\n${instructions}`);
}

export const VALID_FRONT = 'name: reviewer\ndescription: Reviews a change\nprovider: claude_code';

export interface Fixture {
  /** The folder's name. */
  folder: string;
  entries: AgentEntry[];
  /** What the validation must report, as `code@path`. */
  expected: string[];
}

const valid = (extra = ''): AgentEntry =>
  entryFile(extra === '' ? VALID_FRONT : `${VALID_FRONT}\n${extra}`);

/** Every refusal, one failing fixture each. */
export const FAILING: Record<string, Fixture> = {
  entry_missing: {
    folder: 'reviewer',
    entries: [file('README.md', 'hello')],
    expected: ['entry_missing@AGENT.md'],
  },
  'entry_missing (wrong case)': {
    folder: 'reviewer',
    entries: [file('agent.md', `---\n${VALID_FRONT}\n---\nx`)],
    expected: ['entry_missing@AGENT.md'],
  },
  entry_unreadable: {
    folder: 'reviewer',
    entries: [binary('AGENT.md', 40)],
    expected: ['entry_unreadable@AGENT.md'],
  },
  'entry_unreadable (not UTF-8 text)': {
    folder: 'reviewer',
    entries: [file('AGENT.md', `---\n${VALID_FRONT}\n---\n\uFFFD`)],
    expected: ['entry_unreadable@AGENT.md'],
  },
  front_matter_missing: {
    folder: 'reviewer',
    entries: [file('AGENT.md', 'Just instructions.\n')],
    expected: ['front_matter_missing@AGENT.md'],
  },
  'front_matter_missing (never closed)': {
    folder: 'reviewer',
    entries: [file('AGENT.md', `---\n${VALID_FRONT}\nno end`)],
    expected: ['front_matter_missing@AGENT.md'],
  },
  front_matter_malformed: {
    folder: 'reviewer',
    entries: [entryFile('name: [unclosed')],
    expected: ['front_matter_malformed@AGENT.md'],
  },
  'front_matter_malformed (a list)': {
    folder: 'reviewer',
    entries: [entryFile('- a\n- b')],
    expected: ['front_matter_malformed@AGENT.md'],
  },
  'front_matter_malformed (duplicate key)': {
    folder: 'reviewer',
    entries: [valid('name: other')],
    expected: ['front_matter_malformed@AGENT.md'],
  },
  'front_matter_malformed (alias)': {
    folder: 'reviewer',
    entries: [entryFile('name: &n reviewer\ndescription: *n\nprovider: codex')],
    expected: ['front_matter_malformed@AGENT.md'],
  },
  'front_matter_malformed (custom tag)': {
    folder: 'reviewer',
    entries: [valid('model: !!js/function x')],
    expected: ['front_matter_malformed@AGENT.md'],
  },
  'front_matter_malformed (non-text key)': {
    folder: 'reviewer',
    entries: [valid('1: x')],
    expected: ['front_matter_malformed@AGENT.md'],
  },
  front_matter_too_large: {
    folder: 'reviewer',
    entries: [valid(`# ${'x'.repeat(9000)}`)],
    expected: ['front_matter_too_large@AGENT.md'],
  },
  'key_missing (name)': {
    folder: 'reviewer',
    entries: [entryFile('description: d\nprovider: codex')],
    expected: ['key_missing@AGENT.md'],
  },
  'key_missing (description)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\nprovider: codex')],
    expected: ['key_missing@AGENT.md'],
  },
  'key_missing (provider)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: d')],
    expected: ['key_missing@AGENT.md'],
  },
  'key_missing (empty front matter)': {
    folder: 'reviewer',
    entries: [file('AGENT.md', '---\n---\nx')],
    expected: ['key_missing@AGENT.md', 'key_missing@AGENT.md', 'key_missing@AGENT.md'],
  },
  'key_invalid (description empty)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: ""\nprovider: codex')],
    expected: ['key_invalid@AGENT.md'],
  },
  'key_invalid (description too long)': {
    folder: 'reviewer',
    entries: [entryFile(`name: reviewer\ndescription: ${'d'.repeat(501)}\nprovider: codex`)],
    expected: ['key_invalid@AGENT.md'],
  },
  'key_invalid (description on two lines)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: "a\\nb"\nprovider: codex')],
    expected: ['key_invalid@AGENT.md'],
  },
  'key_invalid (description not text)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: [a]\nprovider: codex')],
    expected: ['key_invalid@AGENT.md'],
  },
  'key_invalid (name not text)': {
    folder: 'reviewer',
    entries: [entryFile('name: 12\ndescription: d\nprovider: codex')],
    expected: ['key_invalid@AGENT.md'],
  },
  'key_invalid (provider not text)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: d\nprovider: true')],
    expected: ['key_invalid@AGENT.md'],
  },
  'key_invalid (model not text)': {
    folder: 'reviewer',
    entries: [valid('model: 5')],
    expected: ['key_invalid@AGENT.md'],
  },
  provider_unknown: {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: d\nprovider: gemini')],
    expected: ['provider_unknown@AGENT.md'],
  },
  model_unknown: {
    folder: 'reviewer',
    entries: [valid('model: gpt-6.2-sol')],
    expected: ['model_unknown@AGENT.md'],
  },
  'model_unknown (other Provider)': {
    folder: 'reviewer',
    entries: [entryFile('name: reviewer\ndescription: d\nprovider: codex\nmodel: opus')],
    expected: ['model_unknown@AGENT.md'],
  },
  name_invalid: {
    folder: 'Reviewer',
    entries: [entryFile('name: Reviewer\ndescription: d\nprovider: codex')],
    expected: ['name_invalid@AGENT.md', 'name_invalid@'],
  },
  'name_invalid (folder name only)': {
    folder: 'my agent',
    entries: [entryFile('name: reviewer\ndescription: d\nprovider: codex')],
    expected: ['name_invalid@', 'name_mismatch@AGENT.md'],
  },
  name_reserved: {
    folder: 'default-codex',
    entries: [entryFile('name: default-codex\ndescription: d\nprovider: codex')],
    expected: ['name_reserved@'],
  },
  name_mismatch: {
    folder: 'planner',
    entries: [valid()],
    expected: ['name_mismatch@AGENT.md'],
  },
  unknown_key: {
    folder: 'reviewer',
    entries: [valid('colour: red')],
    expected: ['unknown_key@AGENT.md'],
  },
  'unknown_key (case differs)': {
    folder: 'reviewer',
    entries: [valid('Model: opus')],
    expected: ['unknown_key@AGENT.md'],
  },
  forbidden_key: {
    folder: 'reviewer',
    entries: [valid('tools: [Bash]')],
    expected: ['forbidden_key@AGENT.md'],
  },
  instructions_too_large: {
    folder: 'reviewer',
    entries: [entryFile(VALID_FRONT, 'x'.repeat(64 * 1024 + 1))],
    expected: ['instructions_too_large@AGENT.md'],
  },
  too_many_files: {
    folder: 'reviewer',
    entries: [
      valid(),
      ...Array.from({ length: 100 }, (_, index) => file(`scripts/s${index}.sh`, 'x')),
    ],
    expected: ['too_many_files@'],
  },
  file_too_large: {
    folder: 'reviewer',
    entries: [valid(), binary('assets/big.bin', 1024 * 1024 + 1)],
    expected: ['file_too_large@assets/big.bin'],
  },
  folder_too_large: {
    folder: 'reviewer',
    entries: [
      valid(),
      ...Array.from({ length: 6 }, (_, index) => binary(`assets/part${index}.bin`, 1024 * 1024)),
    ],
    expected: ['folder_too_large@'],
  },
  'path_outside_folder (absolute)': {
    folder: 'reviewer',
    entries: [valid(), file('/etc/passwd', 'x')],
    expected: ['path_outside_folder@/etc/passwd'],
  },
  'path_outside_folder (drive letter)': {
    folder: 'reviewer',
    entries: [valid(), file('C:/x', 'x')],
    expected: ['path_outside_folder@C:/x'],
  },
  'path_outside_folder (..)': {
    folder: 'reviewer',
    entries: [valid(), file('../other/AGENT.md', 'x')],
    expected: ['path_outside_folder@../other/AGENT.md'],
  },
  'path_outside_folder (backslash)': {
    folder: 'reviewer',
    entries: [valid(), file('a\\b.txt', 'x')],
    expected: ['path_outside_folder@a\\b.txt'],
  },
  'path_outside_folder (empty segment)': {
    folder: 'reviewer',
    entries: [valid(), file('a//b.txt', 'x')],
    expected: ['path_outside_folder@a//b.txt'],
  },
  'path_outside_folder (dot segment)': {
    folder: 'reviewer',
    entries: [valid(), file('./a.txt', 'x')],
    expected: ['path_outside_folder@./a.txt'],
  },
  nested_git: {
    folder: 'reviewer',
    entries: [valid(), file('vendor/.git/config', 'x')],
    expected: ['nested_git@vendor/.git/config'],
  },
  'nested_git (upper case)': {
    folder: 'reviewer',
    entries: [valid(), { path: '.GIT', kind: 'directory', size: 0 }],
    expected: ['nested_git@.GIT'],
  },
  symlink_refused: {
    folder: 'reviewer',
    entries: [valid(), { path: 'run.sh', kind: 'symlink', size: 5 }],
    expected: ['symlink_refused@run.sh'],
  },
  kind_refused: {
    folder: 'reviewer',
    entries: [valid(), { path: 'sub', kind: 'submodule', size: 0 }],
    expected: ['kind_refused@sub'],
  },
  duplicate_path: {
    folder: 'reviewer',
    entries: [valid(), file('a.txt', '1'), file('a.txt', '2')],
    expected: ['duplicate_path@a.txt'],
  },
};

const reject = (
  code: string,
  path: string,
  kind = 'file',
  folder = 'reviewer',
): [string, Fixture] => [
  `${code} (${path})`,
  {
    folder,
    entries: [valid(), { path, kind, size: kind === 'file' ? 5 : 0, content: 'x' }],
    expected: [`${code}@${path}`],
  },
];

const desc = (value: string): Fixture => ({
  folder: 'reviewer',
  entries: [entryFile(`name: reviewer\ndescription: ${value}\nprovider: codex`)],
  expected: ['key_invalid@AGENT.md'],
});

const badSize = (size: unknown): Fixture => ({
  folder: 'reviewer',
  entries: [valid(), { path: 'a.bin', kind: 'file', size } as unknown as AgentEntry],
  expected: ['size_invalid@a.bin'],
});

Object.assign(FAILING, {
  // Files and folders a CLI discovers settings, skills or memory from.
  ...Object.fromEntries(
    [
      '.claude/settings.json',
      '.claude/skills/x/SKILL.md',
      '.codex/config.toml',
      '.mcp.json',
      '.agents/skills/x',
      '.cursor/rules',
      '.hidden',
      'a/.b/c.txt',
      '.git.',
      'CLAUDE.md',
      'claude.md',
      'CLAUDE.local.md',
      'AGENTS.md',
      'agents.OVERRIDE.md',
      'docs/AGENTS.override.md',
      'docs/skill.md',
      'x/SKILL.md',
    ].map((path) => reject(path === '.git.' ? 'nested_git' : 'cli_config_path', path)),
  ),
  ...Object.fromEntries([reject('cli_config_path', '.claude', 'directory')]),
  // Lookalikes of .git that a checkout on another file system would treat as .git.
  ...Object.fromEntries(
    ['.git ', '.GIT.', 'git~1/config', '.g‌it/config', '.git‍'].map((path) =>
      reject('nested_git', path),
    ),
  ),
  // 8.3 short names.
  ...Object.fromEntries(
    ['PROGRA~1/x.sh', 'a/b~2.txt', 'A~10'].map((path) => reject('short_name', path)),
  ),
  // Lookalikes of CLI settings names, normalised like the .git lookalikes.
  ...Object.fromEntries(
    ['‌.claude/settings.json', '﻿.mcp.json', 'CLAUDE.md.', 'CLAUDE‌.md', 'AGENTS.md '].map((path) =>
      reject('cli_config_path', path),
    ),
  ),
  'size_invalid (NaN)': badSize(Number.NaN),
  'size_invalid (missing)': badSize(undefined),
  'size_invalid (negative)': badSize(-1),
  'size_invalid (fraction)': badSize(1.5),
  'size_invalid (infinite)': badSize(Number.POSITIVE_INFINITY),
  'size_invalid (text)': badSize('10'),
  'entry_missing (AGENT.md is a directory)': {
    folder: 'reviewer',
    entries: [{ path: 'AGENT.md', kind: 'directory', size: 0 }],
    expected: ['entry_missing@AGENT.md'],
  },
  'duplicate_path (differs in case)': {
    folder: 'reviewer',
    entries: [valid(), file('a.txt', '1'), file('A.TXT', '2')],
    expected: ['duplicate_path@A.TXT'],
  },
  'duplicate_path (entry file in two cases)': {
    folder: 'reviewer',
    entries: [valid(), file('agent.md', 'x')],
    expected: ['duplicate_path@agent.md'],
  },
  'key_invalid (description blank)': desc('"   "'),
  'key_invalid (description NEL)': desc('"a\u0085tools: Bash"'),
  'key_invalid (description line separator)': desc('"a\u2028b"'),
  'key_invalid (description paragraph separator)': desc('"a\u2029b"'),
  'key_invalid (description escape)': desc('"a\u001b[31mb"'),
  'key_invalid (description tab)': desc('"a\tb"'),
  'key_invalid (description C1 control)': desc('"a\u009fb"'),
});

export interface Passing {
  folder: string;
  entries: AgentEntry[];
  definition: {
    name: string;
    description: string;
    provider: string;
    model: string;
    instructions: string;
  };
}

/** Agents the validation accepts. */
export const PASSING: Record<string, Passing> = {
  'only an entry file': {
    folder: 'reviewer',
    entries: [entryFile(VALID_FRONT, 'Review the change.\n')],
    definition: {
      name: 'reviewer',
      description: 'Reviews a change',
      provider: 'claude_code',
      model: 'default',
      instructions: 'Review the change.\n',
    },
  },
  'with scripts and a binary asset': {
    folder: 'builder',
    entries: [
      entryFile(
        'name: builder\ndescription: Builds things\nprovider: codex\nmodel: gpt-6-luna',
        'Build it.\n',
      ),
      { path: 'scripts', kind: 'directory', size: 0 },
      file('scripts/build.sh', '#!/bin/sh\necho ok\n'),
      binary('assets/logo.png', 120_000),
    ],
    definition: {
      name: 'builder',
      description: 'Builds things',
      provider: 'codex',
      model: 'gpt-6-luna',
      instructions: 'Build it.\n',
    },
  },
  'with names that only contain a tilde': {
    folder: 'reviewer',
    entries: [
      entryFile(VALID_FRONT, 'Review the change.\n'),
      file('backup-old~1.txt', 'x'),
      file('release~notes.md', 'x'),
      file('page~1.html', 'x'),
    ],
    definition: {
      name: 'reviewer',
      description: 'Reviews a change',
      provider: 'claude_code',
      model: 'default',
      instructions: 'Review the change.\n',
    },
  },
};
