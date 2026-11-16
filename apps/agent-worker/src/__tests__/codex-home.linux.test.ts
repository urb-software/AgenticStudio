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
import { prepareCodexHome, readConfigTemplate } from '../codex/codex-home.js';

// Issue #106: Studio owns the agent user's Codex configuration. Before every step the worker
// rewrites config.toml (template + an untrusted entry per Working copy), hooks.json with
// Studio's hook, and the rules folder. Linux only, like the worker: runs in CI, skips elsewhere.

const RUN_A = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const RUN_B = '7c1d3e5f-2a4b-4c6d-8e0f-1a3b5c7d9e2f';

describe.skipIf(process.platform !== 'linux')("Studio's Codex home", () => {
  let root: string;
  let home: string;
  let dataDir: string;
  const codex = () => join(home, '.codex');
  const config = () => readFileSync(join(codex(), 'config.toml'), 'utf8');
  const workingCopy = (runId: string) => {
    const repo = join(dataDir, 'runs', runId, 'repo');
    mkdirSync(repo, { recursive: true });
    return repo;
  };
  const prepare = (current: string[] = []) =>
    prepareCodexHome({ home, dataDir, nodePath: '/usr/bin/node' }, current);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'studio-codex-home-'));
    home = join(root, 'home');
    dataDir = join(root, 'data');
    mkdirSync(home);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes the template and marks every existing Working copy and the current one untrusted', async () => {
    const a = workingCopy(RUN_A);
    const b = workingCopy(RUN_B);
    mkdirSync(join(dataDir, 'runs', 'not-a-run', 'repo'), { recursive: true });
    const elsewhere = join(root, 'smoke', 'repo');
    mkdirSync(elsewhere, { recursive: true });

    const prepared = await prepare([elsewhere]);

    expect(prepared.untrusted).toEqual([a, b, elsewhere]);
    const text = config();
    expect(text.startsWith(await readConfigTemplate())).toBe(true);
    for (const path of [a, b, elsewhere]) {
      expect(text).toContain(`[projects."${path}"]\ntrust_level = "untrusted"\n`);
    }
    expect(text).not.toContain('not-a-run');
    expect(text).not.toMatch(/trust_level = "trusted"/);
  });

  it('marks the resolved path of a Working copy reached through a symbolic link too', async () => {
    const real = join(root, 'real-data');
    mkdirSync(join(real, 'runs', RUN_A, 'repo'), { recursive: true });
    symlinkSync(real, dataDir);

    const prepared = await prepare();

    expect(prepared.untrusted).toEqual([
      join(dataDir, 'runs', RUN_A, 'repo'),
      join(real, 'runs', RUN_A, 'repo'),
    ]);
  });

  it("overwrites an agent's edits to the configuration, hooks and rules", async () => {
    mkdirSync(join(codex(), 'rules'), { recursive: true });
    writeFileSync(
      join(codex(), 'config.toml'),
      '[projects."/data"]\ntrust_level = "trusted"\n[mcp_servers.evil]\ncommand = "x"\n',
    );
    writeFileSync(join(codex(), 'hooks.json'), '{"hooks":{"PreToolUse":[]}}');
    writeFileSync(join(codex(), 'rules', 'allow.rules'), 'prefix_rule(pattern=["curl"])');
    writeFileSync(join(codex(), 'rules', 'studio.rules'), '# emptied by the agent');

    await prepare();

    expect(config()).not.toMatch(/trusted"|mcp_servers|evil/);
    expect(readdirSync(join(codex(), 'rules'))).toEqual(['studio.rules']);
    expect(readFileSync(join(codex(), 'rules', 'studio.rules'), 'utf8')).toBe(
      readFileSync(new URL('../../guardrails/codex-studio.rules', import.meta.url), 'utf8'),
    );
    const hooks = JSON.parse(readFileSync(join(codex(), 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PreToolUse[0].matcher).toBe('^(Bash|apply_patch)$');
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(
      `'/usr/bin/node' '${join(codex(), 'studio', 'codex-guard.mjs')}'`,
    );
    expect(existsSync(join(codex(), 'studio', 'codex-guard.mjs'))).toBe(true);
  });

  it('drops the entry of a Working copy once retention removed it', async () => {
    const a = workingCopy(RUN_A);
    await prepare();
    expect(config()).toContain(a);

    rmSync(join(dataDir, 'runs', RUN_A), { recursive: true });
    await prepare();

    expect(config()).not.toContain(a);
  });

  it('never touches the login or the session files', async () => {
    mkdirSync(join(codex(), 'sessions'), { recursive: true });
    writeFileSync(join(codex(), 'auth.json'), '{"test":"test-only-login"}', { mode: 0o600 });
    writeFileSync(join(codex(), 'sessions', 'rollout.jsonl'), 'x');

    await prepare();

    expect(readFileSync(join(codex(), 'auth.json'), 'utf8')).toBe('{"test":"test-only-login"}');
    expect(readFileSync(join(codex(), 'sessions', 'rollout.jsonl'), 'utf8')).toBe('x');
  });

  it('serialises two writers: both finish and the file is whole', async () => {
    const a = workingCopy(RUN_A);
    const b = workingCopy(RUN_B);

    await Promise.all([prepare([a]), prepare([b]), prepare()]);

    const text = config();
    expect(text.startsWith(await readConfigTemplate())).toBe(true);
    expect(text.match(/trust_level = "untrusted"/g)).toHaveLength(2);
    expect(existsSync(join(codex(), '.studio-config.lock'))).toBe(false);
    expect(readdirSync(codex()).filter((name) => name.includes('.studio-'))).toEqual([]);
  });

  it('waits for a held lock and gives up with a clear error', async () => {
    mkdirSync(codex(), { recursive: true });
    writeFileSync(join(codex(), '.studio-config.lock'), '1\n');

    await expect(prepareCodexHome({ home, dataDir, lockTimeoutMs: 100 })).rejects.toThrow(
      "Studio's Codex configuration is locked by another writer",
    );
  });

  it('refuses a template that defines trust entries of its own', async () => {
    const dir = join(root, 'guardrails');
    mkdirSync(dir);
    for (const name of ['codex-hooks.json', 'codex-guard.mjs', 'codex-studio.rules']) {
      writeFileSync(
        join(dir, name),
        readFileSync(new URL(`../../guardrails/${name}`, import.meta.url)),
      );
    }
    writeFileSync(join(dir, 'codex-config.toml'), '[projects."/"]\ntrust_level = "trusted"\n');

    await expect(prepareCodexHome({ home, guardrailsDir: dir })).rejects.toThrow(
      'must not define [projects] or [hooks] tables',
    );
  });
});
