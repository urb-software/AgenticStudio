import { validateAgentFolder } from '@agentic-studio/agent-definitions';
import { describe, expect, it } from 'vitest';
import type {
  AgentDraftFileOutput,
  AgentDraftProblemOutput,
  AgentSummaryOutput,
} from '../../../platform/api';
import {
  agentNameError,
  listProblems,
  newAgentFile,
  overlayDraft,
  pathError,
  validateAgentLive,
} from '../features/agent-editor/draft-model';
import { buildTree, type EditorEntry } from '../features/agent-editor/editor-model';

const entry = (path: string, overrides: Partial<EditorEntry> = {}): EditorEntry => ({
  path,
  kind: 'file',
  size: 10,
  openable: true,
  agent: null,
  ...overrides,
});

const change = (
  path: string,
  kind: AgentDraftFileOutput['change'],
  overrides: Partial<AgentDraftFileOutput> = {},
): AgentDraftFileOutput => ({ path, change: kind, size: 5, movedFrom: null, ...overrides });

describe('overlayDraft', () => {
  const base = [entry('README.md'), entry('agents/a/AGENT.md', { agent: 'a' })];

  it('marks modified and deleted files and adds new ones with their agent', () => {
    const result = overlayDraft(base, [
      change('README.md', 'modified', { size: 99 }),
      change('agents/a/AGENT.md', 'deleted', { size: 0 }),
      change('agents/b/AGENT.md', 'added', { movedFrom: 'agents/a/AGENT.md' }),
    ]);

    expect(result.find((item) => item.path === 'README.md')).toMatchObject({
      change: 'modified',
      size: 99,
    });
    expect(result.find((item) => item.path === 'agents/a/AGENT.md')?.change).toBe('deleted');
    expect(result.find((item) => item.path === 'agents/b/AGENT.md')).toMatchObject({
      change: 'added',
      agent: 'b',
      openable: true,
      movedFrom: 'agents/a/AGENT.md',
    });
  });

  it('leaves the entries alone without changes, and the tree carries the marks', () => {
    expect(overlayDraft(base, [])).toEqual(base);
    const tree = buildTree(overlayDraft(base, [change('new.txt', 'added')]));
    expect(tree.find((node) => node.name === 'new.txt')).toMatchObject({
      kind: 'file',
      entry: { change: 'added' },
    });
  });
});

describe('newAgentFile', () => {
  it.each(['claude_code', 'codex'] as const)('passes the validation for %s', (provider) => {
    const text = newAgentFile('helper', provider);
    const result = validateAgentFolder('helper', [
      { path: 'AGENT.md', kind: 'file', size: text.length, content: text },
    ]);
    expect(result.ok).toBe(true);
  });
});

describe('agentNameError', () => {
  const taken = new Set(['reviewer']);
  it('accepts a plain name', () => {
    expect(agentNameError('helper', taken)).toBeUndefined();
  });
  it.each([
    ['', /name/i],
    ['Bad Name', /lower-case/i],
    ['default-codex', /reserved/i],
    ['reviewer', /already/i],
  ])('refuses %j', (name, message) => {
    expect(agentNameError(name, taken)).toMatch(message);
  });
});

describe('pathError', () => {
  const existing = new Set(['agents/a/README.md']);
  it('accepts a new plain path and a path the Draft deletes', () => {
    expect(pathError('agents/a/new.md', existing)).toBeUndefined();
    expect(
      pathError('agents/a/README.md', existing, new Set(['agents/a/README.md'])),
    ).toBeUndefined();
  });
  it.each([
    ['', /path/i],
    ['/abs.md', /relative/i],
    ['a/../b.md', /relative/i],
    ['a\\b.md', /relative/i],
    ['a//b.md', /relative/i],
    ['.git/config', /git/i],
    ['agents/a/README.md', /already/i],
    ['docs/new.md', /agents\//i],
    ['agents/loose.md', /agents\//i],
  ])('refuses %j', (path, message) => {
    expect(pathError(path, existing)).toMatch(message);
  });
});

describe('validateAgentLive', () => {
  const entries = [
    entry('agents/a/AGENT.md', { agent: 'a' }),
    entry('agents/a/notes.txt', { agent: 'a' }),
  ];
  const text = (provider: string) =>
    `---\nname: a\ndescription: Does a thing\nprovider: ${provider}\n---\nBody`;

  it('finds a problem in the unsaved entry file, at its key', () => {
    const problems = validateAgentLive('a', entries, text('nope'), new Map());
    expect(problems).toEqual([
      expect.objectContaining({
        agent: 'a',
        code: 'provider_unknown',
        target: { path: 'agents/a/AGENT.md' },
      }),
    ]);
  });

  it('finds none for a valid entry file, and skips deleted files', () => {
    const withDeleted = [...entries, entry('agents/a/gone', { agent: 'a', change: 'deleted' })];
    expect(validateAgentLive('a', withDeleted, text('claude_code'), new Map())).toEqual([]);
  });

  it('uses the given size for a file, so a large unsaved file is flagged', () => {
    const problems = validateAgentLive(
      'a',
      entries,
      text('claude_code'),
      new Map([['agents/a/notes.txt', 2 * 1024 * 1024]]),
    );
    expect(problems?.map((problem) => problem.code)).toContain('file_too_large');
  });

  it('says the entry file is missing when the Draft deletes it', () => {
    const deleted = [entry('agents/a/AGENT.md', { agent: 'a', change: 'deleted' })];
    expect(validateAgentLive('a', deleted, undefined, new Map())?.[0]?.code).toBe('entry_missing');
  });

  it('returns nothing while the entry file text is not known', () => {
    expect(validateAgentLive('a', entries, undefined, new Map())).toBeUndefined();
  });
});

describe('listProblems', () => {
  const summary = (name: string, key: string | null): AgentSummaryOutput => ({
    name,
    description: null,
    provider: null,
    model: null,
    source: 'definitions',
    usable: false,
    problems: [{ code: 'key_missing', path: 'AGENT.md', key, message: `${name} problem` }],
  });
  const draftProblem = (agent: string): AgentDraftProblemOutput => ({
    agent,
    code: 'key_missing',
    path: `agents/${agent}/AGENT.md`,
    key: 'model',
    message: `${agent} draft problem`,
  });

  it('takes the base problems of untouched agents, the Draft problems of touched ones', () => {
    const list = listProblems({
      base: [summary('a', 'x'), summary('b', 'y')],
      draft: [draftProblem('b')],
      touched: new Set(['b']),
    });
    expect(list.map((problem) => problem.message)).toEqual(['a problem', 'b draft problem']);
    expect(list[0]?.target).toEqual({ path: 'agents/a/AGENT.md', key: 'x' });
  });

  it('lets the live problems replace those of their agent', () => {
    const live = validateAgentLive(
      'b',
      [entry('agents/b/AGENT.md', { agent: 'b' })],
      '---\nname: b\n---\nx',
      new Map(),
    );
    const list = listProblems({
      base: [],
      draft: [draftProblem('b'), draftProblem('c')],
      touched: new Set(['b', 'c']),
      live: { agent: 'b', problems: live ?? [] },
    });
    expect(list.filter((problem) => problem.agent === 'b').length).toBeGreaterThan(0);
    expect(list.some((problem) => problem.message === 'b draft problem')).toBe(false);
    expect(list.some((problem) => problem.message === 'c draft problem')).toBe(true);
  });
});
