import { describe, expect, it } from 'vitest';
import type { AgentFileEntryOutput, AgentProblemOutput } from '../../../platform/api';
import {
  buildTree,
  frontMatterKeyLine,
  languageOf,
  problemTarget,
} from '../features/agent-editor/editor-model';

const entry = (
  path: string,
  overrides: Partial<AgentFileEntryOutput> = {},
): AgentFileEntryOutput => ({
  path,
  kind: 'file',
  size: 10,
  openable: true,
  agent: null,
  ...overrides,
});

describe('languageOf', () => {
  it.each([
    ['agents/a/AGENT.md', 'markdown'],
    ['x/config.yaml', 'yaml'],
    ['x/config.yml', 'yaml'],
    ['x/data.json', 'json'],
    ['x/run.sh', 'shell'],
    ['x/tool.py', 'python'],
    ['x/tool.js', 'javascript'],
    ['x/tool.mjs', 'javascript'],
    ['x/tool.ts', 'typescript'],
    ['x/tool.tsx', 'typescript'],
    ['x/notes.txt', 'plaintext'],
    ['x/LICENSE', 'plaintext'],
    ['x/.hidden', 'plaintext'],
  ])('%s is %s', (path, language) => {
    expect(languageOf(path)).toBe(language);
  });
});

describe('frontMatterKeyLine', () => {
  const content = [
    '---',
    'name: reviewer',
    'provider: nope',
    'model: opus',
    '---',
    'provider: in body',
  ].join('\n');

  it('finds the key inside the front matter, 1-based', () => {
    expect(frontMatterKeyLine(content, 'provider')).toBe(3);
    expect(frontMatterKeyLine(content, 'name')).toBe(2);
  });

  it('ignores a key after the closing fence and an absent key', () => {
    expect(frontMatterKeyLine(content, 'body')).toBeUndefined();
    expect(frontMatterKeyLine('---\nname: a\n---\nmodel: x', 'model')).toBeUndefined();
  });

  it('is undefined without front matter, and tolerates CRLF and quoted keys', () => {
    expect(frontMatterKeyLine('name: a', 'name')).toBeUndefined();
    expect(frontMatterKeyLine('---\r\nname: a\r\nmodel: b\r\n---\r\n', 'model')).toBe(3);
    expect(frontMatterKeyLine('---\n"model": b\n---\n', 'model')).toBe(2);
  });

  it('does not take a prefix of another key', () => {
    expect(frontMatterKeyLine('---\nmodel_x: 1\n---\n', 'model')).toBeUndefined();
  });
});

describe('problemTarget', () => {
  const problem = (path: string, key: string | null): AgentProblemOutput => ({
    code: 'key_invalid',
    path,
    key,
    message: 'm',
  });

  it('is the file under the agent folder', () => {
    expect(problemTarget('reviewer', problem('notes/big.txt', null))).toEqual({
      path: 'agents/reviewer/notes/big.txt',
    });
  });

  it('is AGENT.md for a folder-level problem', () => {
    expect(problemTarget('reviewer', problem('', null))).toEqual({
      path: 'agents/reviewer/AGENT.md',
    });
  });

  it('carries the front matter key, to find its line', () => {
    expect(problemTarget('reviewer', problem('AGENT.md', 'provider'))).toEqual({
      path: 'agents/reviewer/AGENT.md',
      key: 'provider',
    });
  });
});

describe('buildTree', () => {
  it('nests by path, folders before files, each sorted by name', () => {
    const tree = buildTree([
      entry('README.md'),
      entry('agents/b/AGENT.md', { agent: 'b' }),
      entry('agents/a/z.txt', { agent: 'a' }),
      entry('agents/a/AGENT.md', { agent: 'a' }),
      entry('a-file.txt'),
    ]);
    expect(tree.map((node) => node.path)).toEqual(['agents', 'a-file.txt', 'README.md']);
    const agents = tree[0]!;
    expect(agents.kind).toBe('folder');
    expect(agents.kind === 'folder' && agents.children.map((child) => child.path)).toEqual([
      'agents/a',
      'agents/b',
    ]);
    const a = agents.kind === 'folder' ? agents.children[0]! : undefined;
    expect(a?.kind === 'folder' && a.children.map((child) => child.name)).toEqual([
      'AGENT.md',
      'z.txt',
    ]);
  });

  it('marks the agent folder with the agent name', () => {
    const tree = buildTree([entry('agents/a/AGENT.md', { agent: 'a' })]);
    const agents = tree[0]!;
    const a = agents.kind === 'folder' ? agents.children[0]! : undefined;
    expect(a?.kind === 'folder' && a.agent).toBe('a');
    expect(agents.kind === 'folder' && agents.agent).toBeNull();
  });

  it('keeps the entry on a file node', () => {
    const e = entry('x/link', { kind: 'symlink', openable: false });
    const node = buildTree([e])[0];
    expect(node?.kind === 'folder' && node.children[0]).toMatchObject({
      kind: 'file',
      entry: e,
    });
  });
});
