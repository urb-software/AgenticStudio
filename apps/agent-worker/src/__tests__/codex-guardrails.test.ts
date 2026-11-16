import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readConfigTemplate, tomlString, trustEntries } from '../codex/codex-home.js';
import { readManagedFiles } from '../managed-guardrails.js';

// Issues #106 and #134: Studio's guardrails for Codex, from Studio's own folder: the managed
// configuration and requirements (installed root-owned by the server setup), the user-level
// template the worker still writes (trust entries only) and the command rules. Guardrails, not
// the boundary.

const guardrail = (name: string) =>
  readFileSync(new URL(`../../guardrails/${name}`, import.meta.url), 'utf8');
/** The file without its comment lines. */
const settings = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

describe("Studio's managed Codex configuration (managed_config.toml)", () => {
  const managed = guardrail('codex-managed-config.toml');

  it('is installed as Codex managed defaults', async () => {
    expect(await readManagedFiles()).toContainEqual({
      provider: 'codex',
      source: 'codex-managed-config.toml',
      path: '/etc/codex/managed_config.toml',
    });
  });

  it('turns network access on in the workspace-write sandbox (ADR 0002)', () => {
    expect(managed).toMatch(/\[sandbox_workspace_write\]\nnetwork_access = true\n/);
  });

  it('filters key, secret and token names from commands and passes only the allowlist (finding 4)', () => {
    expect(managed).toContain('[shell_environment_policy]');
    expect(managed).toContain('ignore_default_excludes = false');
    expect(managed).toContain('inherit = "all"');
    const include = /include_only = \[([^\]]*)\]/.exec(managed)?.[1] ?? '';
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

  it('turns app integrations off and defines no trust entries, hooks, MCP servers or sandbox override', () => {
    const body = settings(managed);

    expect(body).toMatch(/\[features\]\napps = false/);
    expect(body).not.toMatch(
      /projects|mcp_servers|danger-full-access|sandbox_mode|approval_policy|trusted|\[hooks/,
    );
  });
});

describe("Studio's Codex requirements (requirements.toml)", () => {
  const body = settings(guardrail('codex-requirements.toml'));

  it('is installed as Codex system requirements', async () => {
    expect(await readManagedFiles()).toContainEqual({
      provider: 'codex',
      source: 'codex-requirements.toml',
      path: '/etc/codex/requirements.toml',
    });
  });

  it('lets only managed hooks run and keeps hooks on', () => {
    expect(body).toMatch(/^allow_managed_hooks_only = true$/m);
    expect(body).toMatch(/\[features\]\nhooks = true\n/);
  });

  it("runs Studio's root-owned guard script with the root-owned Node.js, by absolute paths", async () => {
    const guard = (await readManagedFiles()).find(
      (file) => file.provider === 'codex' && file.source === 'claude-guard.mjs',
    );

    expect(guard?.path).toBe('/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs');
    expect(body).toContain('managed_dir = "/usr/local/lib/agentic-studio/guardrails"\n');
    expect(body).toContain('[[hooks.PreToolUse]]\nmatcher = "^(Bash|apply_patch)$"\n');
    expect(body).toContain(`command = "/usr/local/bin/node ${guard?.path}"\n`);
    expect([...body.matchAll(/^command = /gm)]).toHaveLength(1);
  });

  it('enforces the same command rules as the user-level rules file, all forbidden', () => {
    // codex-studio.rules (Starlark): `pattern = [...]` is JSON. requirements.toml: inline tables.
    const fromRules = [...guardrail('codex-studio.rules').matchAll(/pattern = (\[.*\]),\n/g)].map(
      (match) => JSON.parse(match[1]!) as unknown,
    );
    const decisions: string[] = [];
    const fromRequirements = [
      ...body.matchAll(/\{ pattern = (\[.*?\]), decision = "([a-z]+)"/g),
    ].map((match) => {
      decisions.push(match[2]!);
      const json = match[1]!
        .replace(/\{ token = ("[^"]*") \}/g, '$1')
        .replace(/\{ any_of = (\[[^\]]*\]) \}/g, '$1');
      return JSON.parse(json) as unknown;
    });

    expect(fromRules).toHaveLength(4);
    expect(fromRequirements).toEqual(fromRules);
    expect(new Set(decisions)).toEqual(new Set(['forbidden']));
  });
});

describe("Studio's user-level Codex configuration template", () => {
  it('holds no settings since #134: only the trust entries are appended', async () => {
    expect(settings(await readConfigTemplate()).trim()).toBe('');
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
  const rules = guardrail('codex-studio.rules');

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
