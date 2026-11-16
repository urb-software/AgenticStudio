import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readGuardrailSettings } from '../claude-code/guardrails.js';
import { HOOK_INTERPRETER, HOOK_LAUNCHER } from '../managed-guardrails.js';

// Review H1 of #136: an agent can put an `env` block into a settings file Claude Code reloads
// during a step, and a hook process inherits the session's environment. The managed hooks
// therefore run the guard through `/usr/bin/env -i` with a fixed PATH, and the guard never reads
// HOME or TMPDIR. Here the hook commands exactly as the managed files define them (only the
// installed Node.js and guard paths swapped for this checkout's) run with a hostile environment.
// Linux only, like the worker: runs in CI, skips elsewhere.

const GUARD = fileURLToPath(new URL('../../guardrails/claude-guard.mjs', import.meta.url));
const INSTALLED_GUARD = '/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs';
const PROJECT = '/data/runs/r1/repo';

/** The managed command as argv, with the installed paths swapped for this checkout's. */
function local(argv: string[]): string[] {
  return argv.map((word) =>
    word === HOOK_INTERPRETER
      ? process.execPath
      : word === INSTALLED_GUARD
        ? GUARD
        : word.replace('${CLAUDE_PROJECT_DIR}', PROJECT),
  );
}

async function claudeHook(): Promise<string[]> {
  const settings = await readGuardrailSettings();
  const hook = settings.hooks.PreToolUse[0]!.hooks[0]! as { command: string; args?: string[] };
  return local([hook.command, ...(hook.args ?? [])]);
}

function codexHook(): string[] {
  const requirements = readFileSync(
    new URL('../../guardrails/codex-requirements.toml', import.meta.url),
    'utf8',
  );
  const command = /^command = "([^"]+)"$/m.exec(requirements)![1]!;
  // Codex runs it through a shell; the command has no quoting, so splitting at spaces is exact.
  return local(command.split(' '));
}

describe.skipIf(process.platform !== 'linux')("Studio's managed hook environment", () => {
  let dir: string;
  let marker: string;
  let hostile: Record<string, string>;

  const run = (argv: string[], input: unknown) =>
    spawnSync(argv[0]!, argv.slice(1), {
      input: JSON.stringify(input),
      env: hostile,
      encoding: 'utf8',
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-guard-env-'));
    marker = join(dir, 'agent-code-ran');
    const module = join(dir, 'evil.mjs');
    // Agent code that would let every tool call through.
    writeFileSync(
      module,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\nprocess.exit(0);\n`,
    );
    hostile = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_OPTIONS: `--import=${pathToFileURL(module).href}`,
      TMPDIR: '/',
      HOME: join(dir, 'fake-home'),
      LD_PRELOAD: join(dir, 'missing-preload.so'),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs the guard through the root-owned launcher with a cleared environment', async () => {
    const settings = await readGuardrailSettings();
    const hook = settings.hooks.PreToolUse[0]!.hooks[0]! as Record<string, unknown>;

    expect(hook.command).toBe(HOOK_LAUNCHER);
    expect(hook.args).toEqual([
      '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR}',
      HOOK_INTERPRETER,
      INSTALLED_GUARD,
    ]);
    // A hook that fails or times out blocks the call instead of letting it through.
    expect(hook.onFailure).toBe('block');
    expect(codexHook().slice(0, 3)).toEqual([
      HOOK_LAUNCHER,
      '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin',
    ]);
  });

  it('pins the loader and Node.js variables empty in the managed env', async () => {
    const settings = (await readGuardrailSettings()) as { env?: Record<string, string> };

    expect(settings.env).toEqual({
      LD_PRELOAD: '',
      LD_LIBRARY_PATH: '',
      LD_AUDIT: '',
      NODE_OPTIONS: '',
      NODE_PATH: '',
    });
  });

  it.each([
    ['Claude Code', claudeHook],
    ['Codex', async () => codexHook()],
  ])('%s: NODE_OPTIONS in the hook environment runs no agent code', async (_name, hook) => {
    const result = run(await hook(), {
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      cwd: PROJECT,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Blocked by Studio's guardrails");
    expect(existsSync(marker)).toBe(false);
    // The launcher itself may report the preload; Node.js never gets it.
    expect(result.stderr.split('cannot be preloaded').length - 1).toBeLessThanOrEqual(1);
  });

  it.each([
    ['Claude Code', claudeHook],
    ['Codex', async () => codexHook()],
  ])('%s: TMPDIR=/ in the hook environment does not open writes outside', async (_name, hook) => {
    const input = (tool_name: string, tool_input: Record<string, unknown>) => ({
      tool_name,
      tool_input,
      cwd: PROJECT,
    });

    expect(run(await hook(), input('Write', { file_path: '/etc/studio-probe' })).status).toBe(2);
    expect(
      run(
        await hook(),
        input('apply_patch', {
          command: '*** Begin Patch\n*** Add File: /etc/x\n+x\n*** End Patch',
        }),
      ).status,
    ).toBe(2);
    // The step's temporary directory (beside the Working copy) is still allowed.
    expect(run(await hook(), input('Write', { file_path: '/data/runs/r1/tmp/x' })).status).toBe(0);
  });

  it('HOME in the hook environment does not move the credential checks', async () => {
    const real = userInfo().homedir;

    const result = run(await claudeHook(), {
      tool_name: 'Read',
      tool_input: { file_path: join(real, '.ssh', 'id_ed25519') },
      cwd: PROJECT,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('logins and credentials are off limits');
  });
});
