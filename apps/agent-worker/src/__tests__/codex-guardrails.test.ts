import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readConfigTemplate, tomlString, trustEntries } from '../codex/codex-home.js';

// Issue #106: Studio's guardrails for Codex, from Studio's own folder: the configuration
// template and the command rules (Studio's only Codex guardrail: no Studio hook, coordinator
// decision after the smoke of #133). Guardrails, not the boundary.

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

  it('leaves the hooks flag at its default and defines no trust entries, MCP servers or sandbox override', async () => {
    const template = await readConfigTemplate();
    const settings = template
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(settings).not.toMatch(/projects|mcp_servers|danger-full-access|sandbox_mode|trusted/);
    expect(settings).toMatch(/\[features\]\napps = false/);
    // Smoke of #133: in 0.169.0 `hooks = false` also stopped AGENTS.md from loading; the flag
    // stays at the CLI's default (no Studio hook, hooks.json removed before every step).
    expect(settings).not.toMatch(/^\s*hooks\s*=/m);
    expect(settings).not.toMatch(/features\.hooks|codex_hooks/);
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
