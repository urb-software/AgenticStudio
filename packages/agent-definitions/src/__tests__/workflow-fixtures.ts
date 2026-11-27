import type { AgentEntry } from '../index.js';
import { binary, file, type Fixture } from './fixtures.js';

export function workflowFile(front: string, body = 'Notes for the operator.\n'): AgentEntry {
  return file('WORKFLOW.md', `---\n${front}\n---\n${body}`);
}

export const HEAD = 'name: ship\ndescription: Build, then review';
export const WORK = '  - id: build\n    kind: work\n    agent: implementer';
export const REVIEW = '  - id: check\n    kind: review\n    agent: reviewer';
export const CHECKPOINT = '  - id: ask\n    kind: checkpoint\n    text: Look before going on';

export const sequence = (...items: string[]): string => `sequence:\n${items.join('\n')}`;
export const VALID_FRONT = `${HEAD}\n${sequence(WORK, REVIEW)}`;

const front = (...lines: string[]): AgentEntry => workflowFile(lines.join('\n'));
const withSequence = (...items: string[]): AgentEntry => front(HEAD, sequence(...items));
const withExtra = (extra: string): AgentEntry => front(VALID_FRONT, extra);
const item = (id: string, extra: string): string => `  - id: ${id}\n${extra}`;

const fixture = (entries: AgentEntry[], expected: string[], folder = 'ship'): Fixture => ({
  folder,
  entries,
  expected,
});
// Reasons about another file name it (the last entry); the rest are about the entry file.
const ABOUT_ANOTHER_FILE = new Set([
  'workflow_extra_file',
  'path_outside_folder',
  'nested_git',
  'symlink_refused',
  'kind_refused',
  'cli_config_path',
  'short_name',
]);
const only = (code: string, entries: AgentEntry[], folder = 'ship'): Fixture => {
  const path = ABOUT_ANOTHER_FILE.has(code)
    ? (entries[entries.length - 1] as AgentEntry).path
    : 'WORKFLOW.md';
  return fixture(entries, [`${code}@${path}`], folder);
};

const many = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `  - id: w${index}\n    kind: work\n    agent: a`);

const extras = Array.from({ length: 100 }, (_, index) => file(`f${index}.txt`, 'x'));
const bigFiles = [1, 2, 3, 4, 5, 6].map((n) => binary(`b${n}.bin`, 1024 * 1024));

/** Every refusal reachable for a workflow, one failing fixture each. */
export const WORKFLOW_FAILING: Record<string, Fixture> = {
  entry_missing: only('entry_missing', []),
  entry_unreadable: only('entry_unreadable', [binary('WORKFLOW.md', 40)]),
  'entry_unreadable (not UTF-8 text)': only('entry_unreadable', [
    file('WORKFLOW.md', `---\n${VALID_FRONT}\n---\n�`),
  ]),
  front_matter_missing: only('front_matter_missing', [file('WORKFLOW.md', 'Just text.\n')]),
  front_matter_malformed: only('front_matter_malformed', [front('name: [unclosed')]),
  front_matter_too_large: only('front_matter_too_large', [
    workflowFile(`${VALID_FRONT}\n# ${'x'.repeat(9000)}`),
  ]),
  'key_missing (name)': only('key_missing', [front('description: d', sequence(WORK))]),
  'key_missing (description)': only('key_missing', [front('name: ship', sequence(WORK))]),
  'key_missing (sequence)': only('key_missing', [front(HEAD)]),
  'key_missing (phase agent)': only('key_missing', [withSequence(item('build', '    kind: work'))]),
  'key_missing (checkpoint text)': only('key_missing', [
    withSequence(WORK, item('ask', '    kind: checkpoint'), REVIEW),
  ]),
  'key_invalid (empty description)': only('key_invalid', [
    front('name: ship', 'description: ""', sequence(WORK)),
  ]),
  'key_invalid (description with a line break)': only('key_invalid', [
    front('name: ship', 'description: "a\\nb"', sequence(WORK)),
  ]),
  'key_invalid (sequence is not a list)': only('key_invalid', [front(HEAD, 'sequence: build')]),
  'key_invalid (send-backs is text)': only('key_invalid', [withExtra('send-backs: "1"')]),
  'key_invalid (send-backs is a fraction)': only('key_invalid', [withExtra('send-backs: 1.5')]),
  'key_invalid (agent is not an agent name)': only('key_invalid', [
    withSequence(item('build', '    kind: work\n    agent: Bad Name')),
  ]),
  'key_invalid (agent is not text)': only('key_invalid', [
    withSequence(item('build', '    kind: work\n    agent: 5')),
  ]),
  'key_invalid (instructions are not text)': only('key_invalid', [
    withSequence(`${WORK}\n    instructions: [a]`),
  ]),
  'key_invalid (checkpoint text is too long)': only('key_invalid', [
    withSequence(WORK, item('ask', `    kind: checkpoint\n    text: ${'t'.repeat(501)}`), REVIEW),
  ]),
  'key_invalid (checkpoint text has a control character)': only('key_invalid', [
    withSequence(WORK, item('ask', '    kind: checkpoint\n    text: "a\\u0007b"'), REVIEW),
  ]),
  name_invalid: only('name_invalid', [front('name: Ship', 'description: d', sequence(WORK))]),
  'name_invalid (the folder)': fixture(
    [workflowFile(VALID_FRONT)],
    ['name_invalid@', 'name_mismatch@WORKFLOW.md'],
    'Ship',
  ),
  name_mismatch: only('name_mismatch', [workflowFile(VALID_FRONT)], 'other'),
  name_reserved: fixture(
    [front('name: default-codex', 'description: d', sequence(WORK))],
    ['name_reserved@'],
    'default-codex',
  ),
  unknown_key: only('unknown_key', [withExtra('colour: red')]),
  'unknown_key (a work key on a checkpoint)': only('unknown_key', [
    withSequence(WORK, item('ask', '    kind: checkpoint\n    text: t\n    agent: x'), REVIEW),
  ]),
  'unknown_key (a checkpoint key on a phase)': only('unknown_key', [
    withSequence(`${WORK}\n    text: t`),
  ]),
  forbidden_key: only('forbidden_key', [withExtra('allowed-tools: [Bash]')]),
  'forbidden_key (spelling variant)': only('forbidden_key', [withExtra('MCP_Servers: {}')]),
  'forbidden_key (in an item)': only('forbidden_key', [withSequence(`${WORK}\n    hooks: x`)]),
  workflow_forbidden_key: only('workflow_forbidden_key', [withExtra('model: opus')]),
  'workflow_forbidden_key (spelling variant)': only('workflow_forbidden_key', [
    withExtra('Max_Steps: 100'),
  ]),
  'workflow_forbidden_key (in an item)': only('workflow_forbidden_key', [
    withSequence(`${WORK}\n    timeout: 5`),
  ]),
  instructions_too_large: only('instructions_too_large', [
    workflowFile(VALID_FRONT, 'x'.repeat(64 * 1024 + 1)),
  ]),
  'instructions_too_large (a phase)': only('instructions_too_large', [
    withSequence(
      `${WORK}
    instructions: ${'x'.repeat(2 * 1024 + 1)}`,
      REVIEW,
    ),
  ]),
  phase_agent_reserved: only('phase_agent_reserved', [
    withSequence('  - id: build', '    kind: work', '    agent: default-codex', REVIEW),
  ]),
  shell_line: only('shell_line', [workflowFile(VALID_FRONT, 'run !`ls` now\n')]),
  'shell_line (a decoded phase instruction)': only('shell_line', [
    withSequence(`${WORK}\n    instructions: "!\\u0060ls\\u0060"`, REVIEW),
  ]),
  workflow_extra_file: only('workflow_extra_file', [
    workflowFile(VALID_FRONT),
    file('notes.md', 'x'),
  ]),
  'workflow_extra_file (a binary)': only('workflow_extra_file', [
    workflowFile(VALID_FRONT),
    binary('logo.png', 10),
  ]),
  'workflow_extra_file (nested)': only('workflow_extra_file', [
    workflowFile(VALID_FRONT),
    file('docs/WORKFLOW.md', 'x'),
  ]),
  too_many_files: fixture(
    [workflowFile(VALID_FRONT), ...extras],
    ['too_many_files@', ...extras.map((entry) => `workflow_extra_file@${entry.path}`)],
  ),
  file_too_large: only('file_too_large', [binary('WORKFLOW.md', 1024 * 1024 + 1)]),
  folder_too_large: fixture(
    [workflowFile(VALID_FRONT), ...bigFiles],
    ['folder_too_large@', ...bigFiles.map((entry) => `workflow_extra_file@${entry.path}`)],
  ),
  path_outside_folder: only('path_outside_folder', [workflowFile(VALID_FRONT), file('../x', 'x')]),
  nested_git: only('nested_git', [workflowFile(VALID_FRONT), file('.git/config', 'x')]),
  symlink_refused: only('symlink_refused', [workflowFile(VALID_FRONT), symlink('link')]),
  kind_refused: only('kind_refused', [
    workflowFile(VALID_FRONT),
    { path: 'sub', kind: 'submodule', size: 0 },
  ]),
  duplicate_path: only('duplicate_path', [workflowFile(VALID_FRONT), workflowFile(VALID_FRONT)]),
  size_invalid: only('size_invalid', [{ ...workflowFile(VALID_FRONT), size: -1 }]),
  cli_config_path: only('cli_config_path', [workflowFile(VALID_FRONT), file('CLAUDE.md', 'x')]),
  'cli_config_path (a dot segment)': only('cli_config_path', [
    workflowFile(VALID_FRONT),
    file('.claude/settings.json', '{}'),
  ]),
  'cli_config_path (an agent entry file)': only('cli_config_path', [
    workflowFile(VALID_FRONT),
    file('AGENT.md', 'x'),
  ]),
  short_name: only('short_name', [workflowFile(VALID_FRONT), file('PROGRA~1', 'x')]),
  item_invalid: only('item_invalid', [withSequence('  - just text')]),
  'item_invalid (no id)': only('item_invalid', [withSequence('  - kind: work\n    agent: a')]),
  'item_invalid (id of a wrong shape)': only('item_invalid', [
    withSequence('  - id: Build\n    kind: work\n    agent: a'),
  ]),
  'item_invalid (unknown kind)': only('item_invalid', [
    withSequence('  - id: build\n    kind: deploy\n    agent: a'),
  ]),
  item_id_duplicate: only('item_id_duplicate', [
    withSequence(WORK, '  - id: build\n    kind: review\n    agent: reviewer'),
  ]),
  send_backs_out_of_range: only('send_backs_out_of_range', [withExtra('send-backs: 3')]),
  'send_backs_out_of_range (below zero)': only('send_backs_out_of_range', [
    withExtra('send-backs: -1'),
  ]),
  sequence_too_long: only('sequence_too_long', [withSequence(...many(13))]),
  no_phase: only('no_phase', [front(HEAD, 'sequence: []')]),
  review_first: only('review_first', [withSequence(REVIEW, WORK)]),
  review_before_work: fixture(
    [withSequence(CHECKPOINT, REVIEW, WORK)],
    ['checkpoint_first@WORKFLOW.md', 'review_before_work@WORKFLOW.md'],
  ),
  checkpoint_first: only('checkpoint_first', [withSequence(CHECKPOINT, WORK)]),
  checkpoint_last: only('checkpoint_last', [withSequence(WORK, CHECKPOINT)]),
  checkpoints_adjacent: only('checkpoints_adjacent', [
    withSequence(WORK, CHECKPOINT, '  - id: ask2\n    kind: checkpoint\n    text: Again', REVIEW),
  ]),
};

function symlink(path: string): AgentEntry {
  return { path, kind: 'symlink', size: 3 };
}

export interface Passing {
  folder: string;
  entries: AgentEntry[];
  definition: Record<string, unknown>;
}

const phase = (id: string, kind: 'work' | 'review', agent: string) => ({ id, kind, agent });

export const WORKFLOW_PASSING: Record<string, Passing> = {
  'a work and a review phase': {
    folder: 'ship',
    entries: [workflowFile(VALID_FRONT)],
    definition: {
      name: 'ship',
      description: 'Build, then review',
      sendBacks: 2,
      sequence: [phase('build', 'work', 'implementer'), phase('check', 'review', 'reviewer')],
      documentation: 'Notes for the operator.\n',
    },
  },
  'a single work phase and no body': {
    folder: 'ship',
    entries: [workflowFile(`${HEAD}\n${sequence(WORK)}`, '')],
    definition: { sequence: [phase('build', 'work', 'implementer')], documentation: '' },
  },
  'a lowered send-back limit of zero': {
    folder: 'ship',
    entries: [workflowFile(`${VALID_FRONT}\nsend-backs: 0`)],
    definition: { sendBacks: 0 },
  },
  'send-backs left empty (the default)': {
    folder: 'ship',
    entries: [workflowFile(`${VALID_FRONT}\nsend-backs:`)],
    definition: { sendBacks: 2 },
  },
  'a checkpoint between phases and phase instructions': {
    folder: 'ship',
    entries: [
      withSequence(
        `${WORK}\n    instructions: Keep it small.`,
        CHECKPOINT,
        '  - id: fix\n    kind: work\n    agent: implementer',
        REVIEW,
      ),
    ],
    definition: {
      sequence: [
        { ...phase('build', 'work', 'implementer'), instructions: 'Keep it small.' },
        { id: 'ask', kind: 'checkpoint', text: 'Look before going on' },
        phase('fix', 'work', 'implementer'),
        phase('check', 'review', 'reviewer'),
      ],
    },
  },
  'a checkpoint text over several lines': {
    folder: 'ship',
    entries: [
      withSequence(WORK, item('ask', '    kind: checkpoint\n    text: "one\\ntwo"'), REVIEW),
    ],
    definition: {
      sequence: [
        phase('build', 'work', 'implementer'),
        { id: 'ask', kind: 'checkpoint', text: 'one\ntwo' },
        phase('check', 'review', 'reviewer'),
      ],
    },
  },
  'the most items': {
    folder: 'ship',
    entries: [withSequence(...many(12))],
    definition: {},
  },
  'the longest checkpoint text and phase instructions': {
    folder: 'ship',
    entries: [
      withSequence(
        `${WORK}\n    instructions: ${'x'.repeat(2 * 1024)}`,
        item('ask', `    kind: checkpoint\n    text: ${'t'.repeat(500)}`),
        REVIEW,
      ),
    ],
    definition: {},
  },
  'a Markdown body without a shell line': {
    folder: 'ship',
    entries: [workflowFile(VALID_FRONT, '# Notes\n\nCost $5! `code` is fine.\n')],
    definition: { documentation: '# Notes\n\nCost $5! `code` is fine.\n' },
  },
  'a directory entry next to the entry file': {
    folder: 'ship',
    entries: [workflowFile(VALID_FRONT), { path: 'docs', kind: 'directory', size: 0 }],
    definition: { name: 'ship' },
  },
};
