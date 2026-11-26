import type { AgentEntry } from '../index.js';
import { binary, file, type Fixture } from './fixtures.js';

export function skillFile(front: string, instructions = 'Use this skill.\n'): AgentEntry {
  return file('SKILL.md', `---\n${front}\n---\n${instructions}`);
}

export const SKILL_FRONT = 'name: helper\ndescription: Helps with things';

const valid = (extra = ''): AgentEntry =>
  skillFile(extra === '' ? SKILL_FRONT : `${SKILL_FRONT}\n${extra}`);

const fixture = (entries: AgentEntry[], expected: string[], folder = 'helper'): Fixture => ({
  folder,
  entries,
  expected,
});

const invalid = (extra: string): Fixture => fixture([valid(extra)], ['key_invalid@SKILL.md']);

const manyKeys = Array.from({ length: 21 }, (_, index) => `  k${index}: v`).join('\n');

/** Every refusal reachable for a skill, one failing fixture each. */
export const SKILL_FAILING: Record<string, Fixture> = {
  entry_missing: fixture([file('README.md', 'x')], ['entry_missing@SKILL.md']),
  'entry_missing (an agent entry file is not a skill)': fixture(
    [file('AGENT.md', `---\n${SKILL_FRONT}\n---\nx`)],
    ['entry_missing@SKILL.md', 'cli_config_path@AGENT.md'],
  ),
  'entry_missing (wrong case)': fixture(
    [file('skill.md', `---\n${SKILL_FRONT}\n---\nx`)],
    ['entry_missing@SKILL.md', 'cli_config_path@skill.md'],
  ),
  entry_unreadable: fixture([binary('SKILL.md', 40)], ['entry_unreadable@SKILL.md']),
  'entry_unreadable (not UTF-8 text)': fixture(
    [file('SKILL.md', `---\n${SKILL_FRONT}\n---\n\uFFFD`)],
    ['entry_unreadable@SKILL.md'],
  ),
  'entry_unreadable (a Markdown file never read)': fixture(
    [valid(), binary('docs/guide.md', 40)],
    ['entry_unreadable@docs/guide.md'],
  ),
  front_matter_missing: fixture(
    [file('SKILL.md', 'Just text.\n')],
    ['front_matter_missing@SKILL.md'],
  ),
  front_matter_malformed: fixture(
    [skillFile('name: [unclosed')],
    ['front_matter_malformed@SKILL.md'],
  ),
  'front_matter_malformed (duplicate key)': fixture(
    [valid('name: other')],
    ['front_matter_malformed@SKILL.md'],
  ),
  front_matter_too_large: fixture(
    [valid(`# ${'x'.repeat(9000)}`)],
    ['front_matter_too_large@SKILL.md'],
  ),
  'key_missing (name)': fixture([skillFile('description: d')], ['key_missing@SKILL.md']),
  'key_missing (description)': fixture([skillFile('name: helper')], ['key_missing@SKILL.md']),
  'key_invalid (description empty)': fixture(
    [skillFile('name: helper\ndescription: ""')],
    ['key_invalid@SKILL.md'],
  ),
  'key_invalid (description too long)': fixture(
    [skillFile(`name: helper\ndescription: ${'d'.repeat(1025)}`)],
    ['key_invalid@SKILL.md'],
  ),
  'key_invalid (description on two lines)': fixture(
    [skillFile('name: helper\ndescription: "a\\nb"')],
    ['key_invalid@SKILL.md'],
  ),
  'key_invalid (description not text)': fixture(
    [skillFile('name: helper\ndescription: [a]')],
    ['key_invalid@SKILL.md'],
  ),
  'key_invalid (name not text)': fixture(
    [skillFile('name: 12\ndescription: d')],
    ['key_invalid@SKILL.md'],
  ),
  'key_invalid (license not text)': invalid('license: [MIT]'),
  'key_invalid (license empty)': invalid('license: ""'),
  'key_invalid (license too long)': invalid(`license: ${'l'.repeat(501)}`),
  'key_invalid (compatibility not text)': invalid('compatibility: 3'),
  'key_invalid (compatibility on two lines)': invalid('compatibility: "a\\nb"'),
  'key_invalid (metadata not a mapping)': invalid('metadata: [a]'),
  'key_invalid (metadata nested)': invalid('metadata:\n  a:\n    b: c'),
  'key_invalid (metadata value not text)': invalid('metadata:\n  version: 1'),
  'key_invalid (metadata value too long)': invalid(`metadata:\n  a: ${'v'.repeat(257)}`),
  'key_invalid (metadata key too long)': invalid(`metadata:\n  ${'k'.repeat(65)}: v`),
  'key_invalid (metadata too many keys)': invalid(`metadata:\n${manyKeys}`),
  name_invalid: fixture(
    [skillFile('name: Helper\ndescription: d')],
    ['name_invalid@SKILL.md', 'name_invalid@'],
    'Helper',
  ),
  'name_invalid (folder name only)': fixture(
    [valid()],
    ['name_invalid@', 'name_mismatch@SKILL.md'],
    'my skill',
  ),
  name_mismatch: fixture([valid()], ['name_mismatch@SKILL.md'], 'other'),
  unknown_key: fixture([valid('colour: red')], ['unknown_key@SKILL.md']),
  'unknown_key (a key of an agent)': fixture([valid('provider: codex')], ['unknown_key@SKILL.md']),
  'unknown_key (case differs)': fixture([valid('License: MIT')], ['unknown_key@SKILL.md']),
  forbidden_key: fixture([valid('allowed-tools: Bash')], ['forbidden_key@SKILL.md']),
  'forbidden_key (isolation)': fixture([valid('isolation: worktree')], ['forbidden_key@SKILL.md']),
  'forbidden_key (context)': fixture([valid('context: fork')], ['forbidden_key@SKILL.md']),
  'forbidden_key (agent)': fixture([valid('agent: Explore')], ['forbidden_key@SKILL.md']),
  instructions_too_large: fixture(
    [skillFile(SKILL_FRONT, 'x'.repeat(64 * 1024 + 1))],
    ['instructions_too_large@SKILL.md'],
  ),
  too_many_files: fixture(
    [valid(), ...Array.from({ length: 100 }, (_, index) => file(`scripts/s${index}.sh`, 'x'))],
    ['too_many_files@'],
  ),
  file_too_large: fixture(
    [valid(), binary('assets/big.bin', 1024 * 1024 + 1)],
    ['file_too_large@assets/big.bin'],
  ),
  folder_too_large: fixture(
    [
      valid(),
      ...Array.from({ length: 6 }, (_, index) => binary(`assets/part${index}.bin`, 1024 * 1024)),
    ],
    ['folder_too_large@'],
  ),
  path_outside_folder: fixture(
    [valid(), file('../other/SKILL.md', 'x')],
    ['path_outside_folder@../other/SKILL.md'],
  ),
  nested_git: fixture(
    [valid(), file('vendor/.git/config', 'x')],
    ['nested_git@vendor/.git/config'],
  ),
  symlink_refused: fixture(
    [valid(), { path: 'run.sh', kind: 'symlink', size: 5 }],
    ['symlink_refused@run.sh'],
  ),
  kind_refused: fixture(
    [valid(), { path: 'sub', kind: 'submodule', size: 0 }],
    ['kind_refused@sub'],
  ),
  duplicate_path: fixture(
    [valid(), file('a.txt', '1'), file('A.txt', '2')],
    ['duplicate_path@A.txt'],
  ),
  size_invalid: fixture(
    [valid(), { path: 'a.bin', kind: 'file', size: -1 } as AgentEntry],
    ['size_invalid@a.bin'],
  ),
  short_name: fixture([valid(), file('PROGRA~1/x.sh', 'x')], ['short_name@PROGRA~1/x.sh']),
  'cli_config_path (hidden)': fixture(
    [valid(), file('.claude/settings.json', 'x')],
    ['cli_config_path@.claude/settings.json'],
  ),
  'cli_config_path (a nested SKILL.md)': fixture(
    [valid(), file('inner/SKILL.md', 'x')],
    ['cli_config_path@inner/SKILL.md'],
  ),
  'cli_config_path (a nested skill.md in another case)': fixture(
    [valid(), file('docs/Skill.md', 'x')],
    ['cli_config_path@docs/Skill.md'],
  ),
  'cli_config_path (a nested AGENT.md)': fixture(
    [valid(), file('inner/AGENT.md', 'x')],
    ['cli_config_path@inner/AGENT.md'],
  ),
  'cli_config_path (AGENT.md at the root)': fixture(
    [valid(), file('AGENT.md', 'x')],
    ['cli_config_path@AGENT.md'],
  ),
  'cli_config_path (AGENTS.md)': fixture(
    [valid(), file('AGENTS.md', 'x')],
    ['cli_config_path@AGENTS.md'],
  ),
  'cli_config_path (CLAUDE.md)': fixture(
    [valid(), file('docs/CLAUDE.md', 'x')],
    ['cli_config_path@docs/CLAUDE.md'],
  ),
  'shell_line (the entry file)': fixture(
    [skillFile(SKILL_FRONT, 'Run !`ls` now.\n')],
    ['shell_line@SKILL.md'],
  ),
  'shell_line (another Markdown file)': fixture(
    [valid(), file('docs/guide.md', 'text\n```!\nls\n```\n')],
    ['shell_line@docs/guide.md'],
  ),
  'shell_line (a YAML escape in the description)': fixture(
    [skillFile('name: helper\ndescription: "Run \\x21\\x60ls\\x60 now"')],
    ['shell_line@SKILL.md'],
  ),
  'shell_line (a YAML escape in license)': fixture(
    [valid('license: "\\x21\\x60ls\\x60"')],
    ['shell_line@SKILL.md'],
  ),
  'shell_line (a YAML escape in compatibility)': fixture(
    [valid('compatibility: "\\x60\\x60\\x60\\x21"')],
    ['shell_line@SKILL.md'],
  ),
  'shell_line (a YAML escape in a metadata value)': fixture(
    [valid('metadata:\n  note: "\\x21\\x24HOME"')],
    ['shell_line@SKILL.md'],
  ),
  'shell_line (a YAML escape in a metadata key)': fixture(
    [valid('metadata:\n  "\\x21\\x60ls\\x60": v')],
    ['shell_line@SKILL.md'],
  ),
  'file_too_large (a Markdown file declared small)': fixture(
    [valid(), { ...file('docs/guide.md', 'x'.repeat(1024 * 1024 + 1)), size: 1 }],
    ['file_too_large@docs/guide.md'],
  ),
  'folder_too_large (Markdown files declared small)': fixture(
    [
      valid(),
      ...Array.from({ length: 6 }, (_, index) => ({
        ...file(`docs/part${index}.md`, 'x'.repeat(1024 * 1024)),
        size: 1,
      })),
    ],
    ['folder_too_large@'],
  ),
  'shell_line (front matter)': fixture([valid('license: "!`ls`"')], ['shell_line@SKILL.md']),
};

export interface PassingSkill {
  folder: string;
  entries: AgentEntry[];
  definition: Record<string, unknown>;
}

export const SKILL_PASSING: Record<string, PassingSkill> = {
  'only an entry file': {
    folder: 'helper',
    entries: [skillFile(SKILL_FRONT, 'Do it.\n')],
    definition: { name: 'helper', description: 'Helps with things', instructions: 'Do it.\n' },
  },
  'the descriptive keys, scripts and assets': {
    folder: 'helper',
    entries: [
      skillFile(
        `${SKILL_FRONT}\nlicense: MIT\ncompatibility: Needs git\nmetadata:\n  author: me\n  version: "1.0"`,
        'Do it.\n',
      ),
      { path: 'scripts', kind: 'directory', size: 0 },
      file('scripts/run.sh', '#!/bin/sh\necho ok\n'),
      file('docs/guide.md', 'A guide with $HOME and !important text.\n'),
      binary('assets/logo.png', 120_000),
    ],
    definition: {
      name: 'helper',
      description: 'Helps with things',
      license: 'MIT',
      compatibility: 'Needs git',
      metadata: { author: 'me', version: '1.0' },
      instructions: 'Do it.\n',
    },
  },
};
