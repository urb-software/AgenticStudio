import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  prepareRepoPlugin,
  REPO_PLUGIN_LIMITS,
  type RepositoryTree,
  TreeListingTooLargeError,
  type TreeEntry,
} from '../claude-code/repo-plugin.js';
import { SHELL_LINE } from '@agentic-studio/agent-definitions';

// Exploit classes of the repository plugin: shell forms, read bounds, paths, frontmatter tricks.

interface Planted {
  text: string;
  mode?: string;
  sha?: string;
}

function repository(files: Record<string, Planted | string>) {
  const blobs = new Map<string, string>();
  const reads: string[] = [];
  const entries: TreeEntry[] = Object.entries(files).map(([path, file], index) => {
    const planted = typeof file === 'string' ? { text: file } : file;
    const sha = planted.sha ?? String(index + 1).padStart(40, '0');
    blobs.set(sha, planted.text);
    return { mode: planted.mode ?? '100644', sha, size: Buffer.byteLength(planted.text), path };
  });
  const tree: RepositoryTree = {
    list: async () => entries,
    blob: async (sha) => {
      reads.push(sha);
      return blobs.get(sha) ?? '';
    },
  };
  return { tree, reads };
}

const skill = (front: string, body = 'Do the thing.\n') => `---\n${front}\n---\n${body}`;
const FENCE = '```';

describe('shell forms the CLI runs', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'studio-plugin-')), 'repo-plugin');
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it.each([
    ['a four-backtick fence', `Run:\n\`${FENCE}!\nid\n\`${FENCE}\n`],
    ['a fence opened mid-line', `Text ${FENCE}!id${FENCE} more\n`],
    ['a fence inside a blockquote', `> ${FENCE}!\n> id\n> ${FENCE}\n`],
    ['a tilde fence', `~~~!\nid\n~~~\n`],
    ['an indented fence', `    ${FENCE}!\n    id\n`],
    ['an inline form', 'Now !`id`\n'],
    ['a fence built from arguments', `${FENCE}$ARGUMENTS\nx\n`],
    ['a tilde fence built from arguments', '~~~$ARGUMENTS\nx\n'],
    ['a bang built from arguments', 'Run !$ARGUMENTS now\n'],
  ])('leaves out a skill with %s, and an agent too', async (_name, body) => {
    const { tree } = repository({
      '.claude/skills/bad/SKILL.md': skill('name: bad', body),
      '.claude/agents/bad.md': skill('name: bad', body),
      '.claude/skills/ok/SKILL.md': skill('name: ok'),
    });

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(readdirSync(join(dir, 'skills'))).toEqual(['ok']);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    expect(plugin.notices).toEqual([
      'Left out skill bad: .claude/skills/bad/SKILL.md contains a shell line.',
      'Left out agent bad: contains a shell line.',
    ]);
  });

  it('catches shell syntax that a quoted frontmatter value spells with escapes', async () => {
    const { tree } = repository({
      '.claude/skills/bad/SKILL.md': skill('description: "!\\u0060id\\u0060"'),
      '.claude/agents/bad.md': skill('description: "!\\u0060id\\u0060"'),
    });

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(plugin.dir).toBeNull();
    expect(plugin.notices).toEqual([
      'Left out skill bad: .claude/skills/bad/SKILL.md contains a shell line.',
      'Left out agent bad: contains a shell line.',
    ]);
  });
});

describe('read bounds', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'studio-plugin-')), 'repo-plugin');
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('refuses a skill with too many entries without reading any of them', async () => {
    const files: Record<string, Planted> = {
      '.claude/skills/many/SKILL.md': { text: skill('name: many'), sha: 'a'.repeat(40) },
    };
    for (let i = 0; i < 5000; i++) {
      files[`.claude/skills/many/f${i}.md`] = { text: 'x'.repeat(60 * 1024), sha: 'b'.repeat(40) };
    }
    const { tree, reads } = repository(files);

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(reads).toEqual([]);
    expect(plugin.dir).toBeNull();
    expect(plugin.notices).toEqual(['Left out skill many: more than 200 files.']);
  });

  it('stops reading once the byte budget is spent, also across invalid skills', async () => {
    const files: Record<string, Planted | string> = {};
    const body = 'y'.repeat(REPO_PLUGIN_LIMITS.fileBytes - 100);
    for (let i = 0; i < 40; i++) {
      // Invalid frontmatter: read, then refused.
      files[`.claude/skills/s${String(i).padStart(2, '0')}/SKILL.md`] = `---\n: bad\n---\n${body}`;
    }
    const { tree, reads } = repository(files);

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(reads.length).toBeLessThanOrEqual(
      Math.ceil(REPO_PLUGIN_LIMITS.totalBytes / (REPO_PLUGIN_LIMITS.fileBytes - 100)),
    );
    expect(plugin.dir).toBeNull();
  });

  it('examines at most 2000 entries in total', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      const name = `s${String(i).padStart(2, '0')}`;
      files[`.claude/skills/${name}/SKILL.md`] = skill(`name: ${name}`);
      for (let j = 0; j < 100; j++) files[`.claude/skills/${name}/f${j}`] = 'x';
    }
    const { tree, reads } = repository(files);

    await prepareRepoPlugin(dir, tree);

    expect(reads.length).toBeLessThanOrEqual(2000);
  });

  it('caps the number of notices', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 400; i++) files[`.claude/skills/Bad${i}/SKILL.md`] = skill('name: x');
    const { tree } = repository(files);

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(plugin.notices).toHaveLength(101);
    expect(plugin.notices.at(-1)).toBe('300 further notices left out.');
  });

  it('leaves the plugin out, with a notice, when the listing was too large', async () => {
    const tree: RepositoryTree = {
      list: async () => {
        throw new TreeListingTooLargeError();
      },
      blob: async () => '',
    };

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(plugin).toEqual({
      dir: null,
      notices: ['Left out all repository skills and agents: the file listing is too large.'],
    });
  });
});

describe('paths and frontmatter tricks', () => {
  let dir: string;
  const out = (path: string) => readFileSync(join(dir, path), 'utf8');
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'studio-plugin-')), 'repo-plugin');
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('skips path segments that are empty, dot, dot-dot or .git', async () => {
    const { tree } = repository({
      '.claude/skills/a/SKILL.md': skill('name: a'),
      '.claude/skills/a/../escape.md': 'x',
      '.claude/skills/a/./dot.md': 'x',
      '.claude/skills/a//empty.md': 'x',
      '.claude/skills/a/.git/config': 'x',
      '.claude/skills/a/.GIT/config': 'x',
      '.claude/skills/a/ok/file.md': 'fine',
    });

    await prepareRepoPlugin(dir, tree);

    expect(readdirSync(join(dir, 'skills', 'a')).sort()).toEqual(['SKILL.md', 'ok']);
    expect(existsSync(join(dir, 'skills', 'escape.md'))).toBe(false);
  });

  it('reads a BOM and CRLF frontmatter, and writes it back with LF', async () => {
    const { tree } = repository({
      '.claude/skills/a/SKILL.md':
        '﻿---\r\nname: a\r\ndescription: Crlf\r\nhooks: {}\r\n---\r\nBody\r\n',
    });

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(out('skills/a/SKILL.md')).toBe('---\nname: a\ndescription: Crlf\n---\nBody\r\n');
    expect(plugin.notices).toEqual(['Dropped frontmatter keys of skill a: hooks.']);
  });

  it('drops case-variant keys and refuses quoted keys', async () => {
    const { tree } = repository({
      '.claude/skills/a/SKILL.md': skill('Allowed-Tools: Bash\nHOOKS: {}\ndescription: d'),
      '.claude/skills/b/SKILL.md': skill('"hooks": {}\ndescription: d'),
      '.claude/agents/c.md': skill("'permissionMode': bypassPermissions\ndescription: d"),
    });

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(out('skills/a/SKILL.md')).toBe('---\nname: a\ndescription: d\n---\nDo the thing.\n');
    expect(existsSync(join(dir, 'skills', 'b'))).toBe(false);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    expect(plugin.notices).toEqual([
      'Dropped frontmatter keys of skill a: Allowed-Tools, HOOKS.',
      'Left out skill b: invalid frontmatter.',
      'Left out agent c: invalid frontmatter.',
    ]);
  });

  it('keeps a kept value on one line, whatever newlines or keys it holds', async () => {
    const { tree } = repository({
      '.claude/skills/a/SKILL.md': skill(
        'description: "x\\nhooks: {PreToolUse: []}\\nallowed-tools: Bash"\nwhen_to_use: |\n  one\n  allowed-tools: Bash\n',
      ),
    });

    await prepareRepoPlugin(dir, tree);

    const lines = out('skills/a/SKILL.md').split('\n');
    expect(lines.slice(0, 4)).toEqual([
      '---',
      'name: a',
      'description: "x\\nhooks: {PreToolUse: []}\\nallowed-tools: Bash"',
      'when_to_use: "one\\nallowed-tools: Bash\\n"',
    ]);
    expect(lines.filter((l) => /^(hooks|allowed-tools):/.test(l))).toEqual([]);
  });

  it('ignores a skills entry that is a symlink and an agent name that is a directory', async () => {
    const { tree } = repository({
      '.claude/skills/link': { text: '/etc', mode: '120000' },
      '.claude/agents/dir.md/inner.md': skill('name: inner'),
      '.claude/skills/ok/SKILL.md': skill('name: ok'),
    });

    const plugin = await prepareRepoPlugin(dir, tree);

    expect(readdirSync(join(dir, 'skills'))).toEqual(['ok']);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    expect(plugin.notices).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'removes a symlink planted at the plugin path and leaves its target alone',
    async () => {
      const outside = mkdtempSync(join(tmpdir(), 'studio-outside-'));
      try {
        writeFileSync(join(outside, 'keep.txt'), 'keep');
        mkdirSync(join(dir, '..'), { recursive: true });
        symlinkSync(outside, dir);
        const { tree } = repository({ '.claude/skills/a/SKILL.md': skill('name: a') });

        await prepareRepoPlugin(dir, tree);

        expect(readdirSync(outside)).toEqual(['keep.txt']);
        expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
        expect(out('skills/a/SKILL.md')).toContain('name: a');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe('the shell-line rule of the repository plugin', () => {
  it('is the shared definitions constant, not a copy that could drift', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'claude-code', 'repo-plugin.ts'),
      'utf8',
    );

    expect(source).toMatch(/import \{ SHELL_LINE \} from '@agentic-studio\/agent-definitions'/);
    expect(source).not.toMatch(/const SHELL_LINE\s*=/);
    expect(SHELL_LINE).toBeInstanceOf(RegExp);
  });
});
