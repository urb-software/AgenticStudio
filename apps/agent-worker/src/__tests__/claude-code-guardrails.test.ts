import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide } from '../../guardrails/claude-guard.mjs';
import { prepareGuardrails, readGuardrailSettings } from '../claude-code/guardrails.js';

// Issue #105: Studio's guardrails for Claude Code, from Studio's own folder: the settings
// (allowed tools, deny rules, the hook) and the PreToolUse hook. Guardrails, not the boundary.

describe("Studio's guardrail settings", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-guardrails-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('allows the working tools and common build tools, and never git push', async () => {
    const { permissions } = await readGuardrailSettings();

    for (const rule of ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(docker:*)']) {
      expect(permissions.allow).toContain(rule);
    }
    expect(permissions.allow).toContain('Bash(docker compose:*)');
    expect(permissions.allow).toContain('Bash(git commit:*)');
    expect(permissions.allow.some((rule) => /^Bash\(git( push)?:/.test(rule))).toBe(false);
  });

  it('denies obviously destructive commands and the system Docker socket', async () => {
    const { permissions } = await readGuardrailSettings();

    for (const rule of [
      'Bash(sudo:*)',
      'Bash(git push:*)',
      'Bash(rm -rf /)',
      'Read(//var/run/docker.sock)',
      'Edit(//var/run/docker.sock)',
      'Read(~/.claude/.credentials.json)',
    ]) {
      expect(permissions.deny).toContain(rule);
    }
  });

  it("copies the settings and the hook into the Run's directory, the hook run by the worker's Node", async () => {
    const target = {
      settingsFile: join(dir, 'claude-settings.json'),
      guardScript: join(dir, 'claude-guard.mjs'),
    };

    const prepared = await prepareGuardrails(target, { nodePath: '/usr/bin/node' });

    const original = await readGuardrailSettings();
    const copy = JSON.parse(readFileSync(target.settingsFile, 'utf8'));
    expect(prepared).toEqual({
      settingsFile: target.settingsFile,
      allowedTools: original.permissions.allow,
    });
    expect(copy.permissions).toEqual(original.permissions);
    expect(copy.hooks.PreToolUse[0].hooks).toEqual([
      { type: 'command', command: `'/usr/bin/node' '${target.guardScript}'`, timeout: 10 },
    ]);
    expect(readFileSync(target.guardScript, 'utf8')).toContain("Studio's PreToolUse hook");
  });
});

describe("Studio's PreToolUse hook", () => {
  const env = {
    CLAUDE_PROJECT_DIR: '/data/runs/r1/repo',
    TMPDIR: '/data/runs/r1/tmp',
    HOME: '/home/agent',
  };
  const bash = (command: string) => decide({ tool_name: 'Bash', tool_input: { command } }, env);
  const tool = (name: string, input: Record<string, unknown>) =>
    decide({ tool_name: name, tool_input: input }, env);

  it.each([
    'sudo apt-get install x',
    'cd /tmp && sudo -n true',
    'su - root',
    'FOO=1 doas ls',
    'git push origin HEAD',
    'git -C . push --force',
    'npm test; git push',
    'rm -rf /',
    'rm -fr ~',
    'rm -r -f $HOME/*',
    'docker -H unix:///var/run/docker.sock ps',
    'docker --host=tcp://127.0.0.1:2375 ps',
    'docker context use default',
    'DOCKER_HOST=unix:///var/run/docker.sock docker ps',
    'curl --unix-socket /var/run/docker.sock http://x/containers/json',
    'cat ~/.claude/.credentials.json',
    'cp ~/.codex/auth.json .',
  ])('blocks %j', (command) => {
    expect(bash(command)).toEqual(expect.any(String));
  });

  it.each([
    'npm test',
    'pnpm install --frozen-lockfile',
    'git status && git commit -m "Add x"',
    'docker compose up -d',
    'docker run --rm hello-world',
    'rm -rf node_modules dist',
    'rm -rf ./build/*',
    'echo "push it" > notes.txt',
  ])('leaves %j to the permission rules', (command) => {
    expect(bash(command)).toBeNull();
  });

  it('lets files be written only inside the Working copy or the temporary directory', () => {
    expect(tool('Write', { file_path: '/data/runs/r1/repo/src/a.ts' })).toBeNull();
    expect(tool('Edit', { file_path: 'src/relative.ts' })).toBeNull();
    expect(tool('Write', { file_path: '/data/runs/r1/tmp/scratch.txt' })).toBeNull();
    for (const outside of [
      '/data/runs/r1/claude-settings.json',
      '/data/runs/r1/repo/../run.json',
      '/data/runs/r2/repo/src/a.ts',
      '/home/agent/.bashrc',
      '/etc/hosts',
    ]) {
      expect(tool('Write', { file_path: outside })).toEqual(expect.any(String));
    }
    expect(tool('NotebookEdit', { notebook_path: '/home/agent/n.ipynb' })).toEqual(
      expect.any(String),
    );
  });

  it('keeps the logins and the system Docker socket out of reach of the reading tools', () => {
    expect(tool('Read', { file_path: '/home/agent/.claude/.credentials.json' })).toEqual(
      expect.any(String),
    );
    expect(tool('Read', { file_path: '~/.ssh/id_ed25519' })).toEqual(expect.any(String));
    expect(tool('Grep', { pattern: 'token', path: '/home/agent/.codex' })).toEqual(
      expect.any(String),
    );
    expect(tool('Read', { file_path: '/var/run/docker.sock' })).toEqual(expect.any(String));
    expect(tool('Read', { file_path: '/data/runs/r1/repo/README.md' })).toBeNull();
    expect(tool('Glob', { pattern: '**/*.ts' })).toBeNull();
  });
});
