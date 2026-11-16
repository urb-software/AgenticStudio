import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decide, patchTargets } from '../../guardrails/codex-guard.mjs';
import { readConfigTemplate, tomlString, trustEntries } from '../codex/codex-home.js';

// Issue #106: Studio's guardrails for Codex, from Studio's own folder: the configuration
// template, the command rules and the PreToolUse hook. Guardrails, not the boundary.

const env = { HOME: '/home/agent' };
const bash = (command: string) => decide({ tool_name: 'Bash', tool_input: { command } }, env);
const patch = (text: string) =>
  decide(
    { tool_name: 'apply_patch', tool_input: { command: text }, cwd: '/data/runs/r1/repo' },
    env,
  );

describe("Studio's Codex configuration template", () => {
  it('turns network access on in the workspace-write sandbox (ADR 0002)', async () => {
    const template = await readConfigTemplate();

    expect(template).toMatch(/\[sandbox_workspace_write\]\nnetwork_access = true\n/);
  });

  it('filters key, secret and token names from commands and passes only the allowlist (finding 4)', async () => {
    const template = await readConfigTemplate();

    expect(template).toContain('[shell_environment_policy]');
    expect(template).toContain('ignore_default_excludes = false');
    expect(template).toContain('inherit = "all"');
    const include = /include_only = \[([^\]]*)\]/.exec(template)?.[1] ?? '';
    expect(include.match(/"([A-Z_]+)"/g)?.map((name) => name.slice(1, -1))).toEqual([
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'LANG',
      'LC_ALL',
      'TZ',
      'XDG_RUNTIME_DIR',
      'DOCKER_HOST',
      'TERM',
      'TMPDIR',
      'COMPOSE_PROJECT_NAME',
    ]);
  });

  it('defines no trust entries, hooks, MCP servers or sandbox override of its own', async () => {
    const template = await readConfigTemplate();
    const settings = template
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(settings).not.toMatch(/projects|mcp_servers|danger-full-access|sandbox_mode|trusted/);
    expect(settings).toMatch(/\[features\]\nhooks = true\napps = false/);
  });

  it('writes Working copy paths as safe TOML strings', () => {
    expect(trustEntries(['/data/runs/a"b\\c/repo'])).toContain(
      '[projects."/data/runs/a\\"b\\\\c/repo"]\ntrust_level = "untrusted"\n',
    );
    expect(() => tomlString('/data/\nevil')).toThrow();
    expect(trustEntries([])).toBe('');
  });
});

describe("Studio's Codex rules", () => {
  const rules = readFileSync(
    new URL('../../guardrails/codex-studio.rules', import.meta.url),
    'utf8',
  );

  it('only forbids; nothing is allowed outside the sandbox or waits for an approval', () => {
    const decisions = [...rules.matchAll(/decision = "([a-z]+)"/g)].map((match) => match[1]);
    expect(decisions.length).toBeGreaterThan(0);
    expect(new Set(decisions)).toEqual(new Set(['forbidden']));
  });

  it('forbids privilege escalation, git push and another Docker daemon', () => {
    expect(rules).toContain('pattern = [["sudo", "su", "doas", "pkexec"]]');
    expect(rules).toContain('pattern = ["git", "push"]');
    expect(rules).toContain('pattern = ["docker", ["-H", "--host", "context"]]');
  });
});

describe("Studio's Codex hook", () => {
  it.each([
    ['sudo ls', 'sudo is not allowed'],
    ['git push origin main', 'git push is not allowed'],
    ['cd x && git push', 'git push is not allowed'],
    ['rm -rf /', 'deleting the root or the home directory'],
    ['docker -H unix:///var/run/docker.sock ps', 'the system Docker daemon is off limits'],
    ['docker --host=tcp://x ps', 'no -H/--host'],
    ['DOCKER_HOST=tcp://x docker ps', 'no DOCKER_HOST='],
    ['cat ~/.codex/auth.json', 'the Codex home are off limits'],
    ['echo x >> $HOME/.codex/config.toml', 'the Codex home are off limits'],
    ['cp evil.rules /home/agent/.codex/rules/', 'the Codex home are off limits'],
    ['cat ~/.ssh/id_ed25519', 'credentials'],
  ])('blocks %j', (command, reason) => {
    expect(bash(command)).toContain(reason);
  });

  it.each([
    'npm test',
    'git status',
    'docker compose up -d',
    'cat .codex/config.toml',
    'rm -rf build',
  ])('lets %j go on', (command) => {
    expect(bash(command)).toBeNull();
  });

  it('blocks patches that write outside the Working copy or into the Codex home', () => {
    expect(
      patchTargets('*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** Move to: b.ts\n'),
    ).toEqual(['src/a.ts', 'b.ts']);
    expect(patch('*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch')).toBeNull();
    expect(patch('*** Begin Patch\n*** Update File: ../../other/repo/a.ts\n*** End Patch')).toBe(
      'files are written only inside the Working copy',
    );
    expect(patch('*** Begin Patch\n*** Add File: ~/.codex/rules/x.rules\n*** End Patch')).toBe(
      'logins, credentials and the Codex home are off limits',
    );
  });

  it('leaves other tools and malformed input alone', () => {
    expect(decide({ tool_name: 'update_plan', tool_input: { command: 'sudo x' } }, env)).toBeNull();
    expect(decide(undefined, env)).toBeNull();
  });
});
