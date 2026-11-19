import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseTreeListing,
  prepareRepoPlugin,
  REPO_PLUGIN_LIMITS,
  type RepositoryTree,
  type TreeEntry,
} from '../claude-code/repo-plugin.js';

// The sanitized per-Run plugin of the repository's skills and subagents.

interface Planted {
  text: string;
  mode?: string;
}

function repository(files: Record<string, Planted | string>): RepositoryTree {
  const blobs = new Map<string, string>();
  const entries: TreeEntry[] = Object.entries(files).map(([path, file], index) => {
    const planted = typeof file === 'string' ? { text: file } : file;
    const sha = String(index + 1).padStart(40, '0');
    blobs.set(sha, planted.text);
    return { mode: planted.mode ?? '100644', sha, size: Buffer.byteLength(planted.text), path };
  });
  return { list: async () => entries, blob: async (sha) => blobs.get(sha) ?? '' };
}

const skill = (front: string, body = 'Do the thing.\n') => `---\n${front}\n---\n${body}`;

describe('the repository plugin', () => {
  let dir: string;
  const out = (path: string) => readFileSync(join(dir, path), 'utf8');

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'studio-plugin-')), 'repo-plugin');
  });
  afterEach(() => rmSync(join(dir, '..'), { recursive: true, force: true }));

  it('is not built when the repository has no skills or agents', async () => {
    const plugin = await prepareRepoPlugin(dir, repository({ 'README.md': 'x' }));

    expect(plugin).toEqual({ dir: null, notices: [] });
    expect(existsSync(dir)).toBe(false);
  });

  it('writes plugin.json, skills and agents under the repo name', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/review/SKILL.md': skill('name: review\ndescription: Reviews code'),
        '.claude/skills/review/notes/extra.md': 'More.\n',
        '.claude/agents/helper.md': skill('name: helper\ndescription: Helps\ntools: Read, Grep'),
      }),
    );

    expect(plugin.dir).toBe(dir);
    expect(JSON.parse(out('.claude-plugin/plugin.json'))).toEqual({ name: 'repo' });
    expect(out('skills/review/SKILL.md')).toBe(
      '---\nname: review\ndescription: Reviews code\n---\nDo the thing.\n',
    );
    expect(out('skills/review/notes/extra.md')).toBe('More.\n');
    expect(out('agents/helper.md')).toContain('tools: Read, Grep');
  });

  it('keeps only the allowlisted skill keys and names the dropped ones', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/a/SKILL.md': skill(
          [
            'name: a',
            'description: d',
            'when_to_use: w',
            'argument-hint: h',
            'disable-model-invocation: true',
            'user-invocable: false',
            'context: fork',
            'agent: Explore',
            'model: sonnet',
            'effort: low',
            'allowed-tools: Bash(*)',
            'hooks:\n  PreToolUse: []',
            'mcpServers: {}',
            'permissionMode: bypassPermissions',
            'memory: user',
            'isolation: worktree',
          ].join('\n'),
        ),
      }),
    );

    const text = out('skills/a/SKILL.md');
    for (const key of [
      'allowed-tools',
      'hooks',
      'mcpServers',
      'permissionMode',
      'memory',
      'isolation',
    ]) {
      expect(text).not.toContain(key);
    }
    for (const kept of ['when_to_use', 'argument-hint', 'context: fork', 'effort: low']) {
      expect(text).toContain(kept);
    }
    expect(plugin.notices).toEqual([
      'Dropped frontmatter keys of skill a: allowed-tools, hooks, mcpServers, permissionMode, memory, isolation.',
    ]);
  });

  it('keeps only the allowlisted agent keys', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/agents/x.md': skill(
          [
            'name: x',
            'description: d',
            'tools: Read',
            'disallowedTools: Write',
            'model: haiku',
            'maxTurns: 5',
            'skills: [a]',
            'effort: low',
            'hooks: {}',
            'mcpServers: {}',
            'permissionMode: bypassPermissions',
            'memory: user',
            'isolation: worktree',
          ].join('\n'),
        ),
      }),
    );

    const text = out('agents/x.md');
    for (const key of ['hooks', 'mcpServers', 'permissionMode', 'memory', 'isolation']) {
      expect(text).not.toContain(key);
    }
    expect(text).toContain('maxTurns: 5');
    expect(plugin.notices).toEqual([
      'Dropped frontmatter keys of agent x: hooks, mcpServers, permissionMode, memory, isolation.',
    ]);
  });

  it('leaves out a skill with a shell line in any of its files, and names it', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/inline/SKILL.md': skill('name: inline', 'Run !`id` now\n'),
        '.claude/skills/fenced/SKILL.md': skill('name: fenced', 'Run:\n```!\nid\n```\n'),
        '.claude/skills/nested/SKILL.md': skill('name: nested'),
        '.claude/skills/nested/ref.md': 'see !`id`\n',
        '.claude/skills/ok/SKILL.md': skill('name: ok'),
      }),
    );

    expect(readdirSync(join(dir, 'skills'))).toEqual(['ok']);
    expect(plugin.notices).toEqual([
      'Left out skill inline: .claude/skills/inline/SKILL.md contains a shell line.',
      'Left out skill fenced: .claude/skills/fenced/SKILL.md contains a shell line.',
      'Left out skill nested: .claude/skills/nested/ref.md contains a shell line.',
    ]);
  });

  it('leaves out invalid names and invalid frontmatter', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/Bad_Name/SKILL.md': skill('name: x'),
        '.claude/skills/-lead/SKILL.md': skill('name: x'),
        '.claude/skills/broken/SKILL.md': '---\ndescription: [unclosed\n---\nx\n',
        '.claude/skills/list/SKILL.md': '---\n- a\n- b\n---\nx\n',
        '.claude/skills/open/SKILL.md': '---\nname: open\nno end\n',
        '.claude/agents/Bad Name.md': skill('name: x'),
      }),
    );

    expect(plugin.dir).toBeNull();
    expect(plugin.notices).toEqual([
      'Left out skill "Bad_Name" (invalid name).',
      'Left out skill "-lead" (invalid name).',
      'Left out skill broken: invalid value for description.',
      'Left out skill list: frontmatter is not a mapping.',
      'Left out skill open: unterminated frontmatter.',
      'Left out agent "Bad Name" (invalid name).',
    ]);
  });

  it('forces the name to the folder name', async () => {
    await prepareRepoPlugin(
      dir,
      repository({ '.claude/skills/real/SKILL.md': skill('name: other\ndescription: d') }),
    );

    expect(out('skills/real/SKILL.md')).toContain('name: real\n');
    expect(out('skills/real/SKILL.md')).not.toContain('other');
  });

  it('skips symbolic links and gitlinks, and drops the executable bit', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/a/SKILL.md': skill('name: a'),
        '.claude/skills/a/link.md': { text: '/etc/passwd', mode: '120000' },
        '.claude/skills/a/sub': { text: '', mode: '160000' },
        '.claude/skills/a/run.sh': { text: 'echo hi\n', mode: '100755' },
        '.claude/skills/linked/SKILL.md': { text: '/etc/passwd', mode: '120000' },
        '.claude/agents/link.md': { text: '/etc/passwd', mode: '120000' },
      }),
    );

    expect(readdirSync(join(dir, 'skills', 'a')).sort()).toEqual(['SKILL.md', 'run.sh']);
    expect(existsSync(join(dir, 'skills', 'linked'))).toBe(false);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'skills', 'a', 'run.sh')).mode & 0o111).toBe(0);
    }
    expect(plugin.notices).toEqual([
      'Left out .claude/skills/a/link.md (not a regular file).',
      'Left out .claude/skills/a/sub (not a regular file).',
      'Left out skill linked: SKILL.md is not a regular file.',
      'Left out agent link: not a regular file.',
    ]);
  });

  it('leaves out a file over the size limit, or a skill whose SKILL.md is', async () => {
    const big = 'x'.repeat(REPO_PLUGIN_LIMITS.fileBytes + 1);
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/a/SKILL.md': skill('name: a'),
        '.claude/skills/a/big.md': big,
        '.claude/skills/b/SKILL.md': skill('name: b', big),
        '.claude/agents/c.md': skill('name: c', big),
      }),
    );

    expect(readdirSync(join(dir, 'skills'))).toEqual(['a']);
    expect(readdirSync(join(dir, 'skills', 'a'))).toEqual(['SKILL.md']);
    expect(existsSync(join(dir, 'agents'))).toBe(false);
    expect(plugin.notices).toEqual([
      'Left out .claude/skills/a/big.md (over 64 KiB).',
      'Left out skill b: SKILL.md is over the size limit.',
      'Left out agent c: over 64 KiB.',
    ]);
  });

  it('caps the number of skills and of agents at 50 each', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 52; i++) {
      const name = `n${String(i).padStart(2, '0')}`;
      files[`.claude/skills/${name}/SKILL.md`] = skill(`name: ${name}`);
      files[`.claude/agents/${name}.md`] = skill(`name: ${name}`);
    }

    const plugin = await prepareRepoPlugin(dir, repository(files));

    expect(readdirSync(join(dir, 'skills'))).toHaveLength(50);
    expect(readdirSync(join(dir, 'agents'))).toHaveLength(50);
    expect(plugin.notices).toEqual([
      'Left out skill n50: more than 50 skills.',
      'Left out skill n51: more than 50 skills.',
      'Left out agent n50: more than 50 agents.',
      'Left out agent n51: more than 50 agents.',
    ]);
  });

  it('caps the plugin at 1 MiB in total', async () => {
    const files: Record<string, string> = {};
    const body = 'y'.repeat(60 * 1024);
    for (let i = 0; i < 20; i++) {
      files[`.claude/skills/s${String(i).padStart(2, '0')}/SKILL.md`] = skill('name: s', body);
    }

    const plugin = await prepareRepoPlugin(dir, repository(files));

    const kept = readdirSync(join(dir, 'skills')).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(20);
    expect(plugin.notices).toHaveLength(20 - kept);
    expect(plugin.notices.every((n) => n.endsWith('the plugin reached 1024 KiB.'))).toBe(true);
  });

  it('leaves out a binary file of a skill', async () => {
    const plugin = await prepareRepoPlugin(
      dir,
      repository({
        '.claude/skills/a/SKILL.md': skill('name: a'),
        '.claude/skills/a/pic.png': 'PNG\0\u0001',
      }),
    );

    expect(readdirSync(join(dir, 'skills', 'a'))).toEqual(['SKILL.md']);
    expect(plugin.notices).toEqual(['Left out .claude/skills/a/pic.png (not text).']);
  });

  it('replaces the directory whole: a file planted after an earlier step is gone', async () => {
    const tree = repository({ '.claude/skills/a/SKILL.md': skill('name: a') });
    await prepareRepoPlugin(dir, tree);
    writeFileSync(join(dir, 'skills', 'a', 'planted.md'), 'x');
    mkdirSync(join(dir, 'hooks'));
    writeFileSync(join(dir, 'hooks', 'hooks.json'), '{}');

    await prepareRepoPlugin(dir, tree);

    expect(readdirSync(join(dir, 'skills', 'a'))).toEqual(['SKILL.md']);
    expect(existsSync(join(dir, 'hooks'))).toBe(false);
  });

  it('removes an old plugin when the repository no longer has content', async () => {
    await prepareRepoPlugin(dir, repository({ '.claude/skills/a/SKILL.md': skill('name: a') }));

    const plugin = await prepareRepoPlugin(dir, repository({}));

    expect(plugin.dir).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('parsing the Git tree listing', () => {
  it('reads mode, sha, size and path, also for spaces and gitlinks', () => {
    const sha = 'a'.repeat(40);
    const out = [
      `100644 blob ${sha}      12\t.claude/skills/a b/SKILL.md`,
      `160000 commit ${sha}       -\t.claude/skills/sub`,
      `120000 blob ${sha}       3\t.claude/agents/x.md`,
    ].join('\0');

    expect(parseTreeListing(out + '\0')).toEqual([
      { mode: '100644', sha, size: 12, path: '.claude/skills/a b/SKILL.md' },
      { mode: '160000', sha, size: 0, path: '.claude/skills/sub' },
      { mode: '120000', sha, size: 3, path: '.claude/agents/x.md' },
    ]);
  });
});
