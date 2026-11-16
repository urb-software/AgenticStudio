import { randomUUID } from 'node:crypto';
import {
  chmodSync,
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
import { AgentSessions, claudeProjectDirectoryName } from '../agent-sessions.js';

// Issue #143: the provider CLIs' session files that go with a removed Working copy, in a throwaway
// home directory. Linux only, like the worker.

describe.skipIf(process.platform !== 'linux')('AgentSessions', () => {
  let home: string;
  let repoDir: string;
  let sessions: AgentSessions;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'studio-home-'));
    repoDir = `/home/agent/data/runs/${randomUUID()}/repo`;
    sessions = new AgentSessions(home);
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const claudeProject = (path: string) =>
    join(home, '.claude', 'projects', claudeProjectDirectoryName(path));

  function codexSession(id: string, day = '2026/11/16'): string {
    const dir = join(home, '.codex', 'sessions', day);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-11-16T10-00-00-${id}.jsonl`);
    writeFileSync(file, '{}\n');
    return file;
  }

  it('names the Claude Code project directory after the working directory', () => {
    expect(claudeProjectDirectoryName('/home/agent/data/runs/ab-12/repo')).toBe(
      '-home-agent-data-runs-ab-12-repo',
    );
  });

  it('removes the Claude Code project directory of the Working copy, and only that one', async () => {
    mkdirSync(claudeProject(repoDir), { recursive: true });
    writeFileSync(join(claudeProject(repoDir), 'session.jsonl'), '{}\n');
    const other = `/home/agent/data/runs/${randomUUID()}/repo`;
    mkdirSync(claudeProject(other), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');

    await sessions.remove(repoDir);

    expect(existsSync(claudeProject(repoDir))).toBe(false);
    expect(existsSync(claudeProject(other))).toBe(true);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{}');
  });

  it('removes the Codex session file of the Run session id, and no other session', async () => {
    const id = randomUUID();
    const mine = codexSession(id);
    const earlier = codexSession(id, '2026/11/15');
    const other = codexSession(randomUUID());
    writeFileSync(join(home, '.codex', 'auth.json'), '{}');

    await sessions.remove(repoDir, { provider: 'codex', ref: id });

    expect(existsSync(mine)).toBe(false);
    expect(existsSync(earlier)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(home, '.codex', 'auth.json'))).toBe(true);
  });

  it('removes no Codex file for a Claude Code session, or for a session id that is not a UUID', async () => {
    const id = randomUUID();
    const file = codexSession(id);

    await sessions.remove(repoDir, { provider: 'claude_code', ref: id });
    await sessions.remove(repoDir, { provider: 'codex', ref: '../../auth' });
    await sessions.remove(repoDir, { provider: 'codex', ref: '*' });

    expect(existsSync(file)).toBe(true);
  });

  it('names the Claude Code directory after the real path of a Working copy reached through a link', async () => {
    const real = join(home, 'data', 'runs', 'x', 'repo');
    mkdirSync(real, { recursive: true });
    const linked = join(home, 'link');
    symlinkSync(join(home, 'data'), linked);
    const viaLink = join(linked, 'runs', 'x', 'repo');
    mkdirSync(claudeProject(real), { recursive: true });
    mkdirSync(claudeProject(viaLink), { recursive: true });

    await sessions.remove(viaLink);

    expect(existsSync(claudeProject(real))).toBe(false);
    expect(existsSync(claudeProject(viaLink))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)(
    'skips a session directory it cannot read, logging it, and still removes the file elsewhere',
    async () => {
      const id = randomUUID();
      const locked = join(home, '.codex', 'sessions', '2026', '11', '15');
      mkdirSync(locked, { recursive: true });
      chmodSync(locked, 0o000);
      const file = codexSession(id, '2026/11/16');
      const errors: string[] = [];
      try {
        await new AgentSessions(home, { error: (m) => errors.push(m) }).remove(repoDir, {
          provider: 'codex',
          ref: id,
        });
      } finally {
        chmodSync(locked, 0o700);
      }

      expect(existsSync(file)).toBe(false);
      expect(errors.join()).toContain('could not read');
    },
  );

  it('does nothing when the CLIs left no files', async () => {
    await expect(
      sessions.remove(repoDir, { provider: 'codex', ref: randomUUID() }),
    ).resolves.toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
  });

  it('never follows a symlink: a linked project directory is removed itself, not its target', async () => {
    const target = join(home, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'keep');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    symlinkSync(target, claudeProject(repoDir));

    await sessions.remove(repoDir);

    expect(existsSync(claudeProject(repoDir))).toBe(false);
    expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('does not walk a symlinked projects or sessions directory', async () => {
    const target = join(home, 'elsewhere');
    const id = randomUUID();
    mkdirSync(join(target, repoDir.replace(/[^A-Za-z0-9]/g, '-')), { recursive: true });
    mkdirSync(join(target, '2026', '11', '16'), { recursive: true });
    const outsideFile = join(target, '2026', '11', '16', `rollout-2026-11-16T10-00-00-${id}.jsonl`);
    writeFileSync(outsideFile, '{}\n');
    mkdirSync(join(home, '.claude'));
    symlinkSync(target, join(home, '.claude', 'projects'));
    mkdirSync(join(home, '.codex'));
    symlinkSync(target, join(home, '.codex', 'sessions'));

    await sessions.remove(repoDir, { provider: 'codex', ref: id });

    expect(existsSync(outsideFile)).toBe(true);
    expect(readdirSync(target)).toHaveLength(2);
  });

  it('refuses a home directory that is not a safe absolute path', () => {
    expect(() => new AgentSessions('relative/home')).toThrow();
    expect(() => new AgentSessions('/')).toThrow();
  });
});
