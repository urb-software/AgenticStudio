import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decide } from '../../guardrails/claude-guard.mjs';
import { readGuardrailSettings } from '../claude-code/guardrails.js';
import { readManagedFiles } from '../managed-guardrails.js';

// Issues #105 and #134: Studio's guardrails for Claude Code, from Studio's own folder: the
// managed settings (allowed tools, deny rules, managed-only hooks and rules, the hook) and the
// PreToolUse hook, which Codex runs too. Guardrails, not the boundary.

describe("Studio's managed Claude Code settings", () => {
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

  it('lets only managed hooks and permission rules apply, and never bypass mode', async () => {
    const settings = await readGuardrailSettings();

    expect(settings.allowManagedHooksOnly).toBe(true);
    expect(settings.allowManagedPermissionRulesOnly).toBe(true);
    expect(settings.permissions.disableBypassPermissionsMode).toBe('disable');
    expect(settings.enableAllProjectMcpServers).toBe(false);
    // Native lock on the file tools, whatever the hook's environment (review H1 of #136).
    expect(settings.permissions.blockWritesOutsideWorkingDirectories).toBe(true);
  });

  it('runs the root-owned guard script with the root-owned Node.js, by absolute paths', async () => {
    const settings = await readGuardrailSettings();
    const guard = (await readManagedFiles()).find(
      (file) => file.provider === 'claude_code' && file.source === 'claude-guard.mjs',
    );

    expect(guard?.path).toBe('/usr/local/lib/agentic-studio/guardrails/claude-guard.mjs');
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: 'Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep',
        hooks: [
          {
            type: 'command',
            // Exec form, no shell; a cleared environment (review H1 of #136).
            command: '/usr/bin/env',
            args: [
              '-i',
              'PATH=/usr/local/bin:/usr/bin:/bin',
              'CLAUDE_PROJECT_DIR=${CLAUDE_PROJECT_DIR}',
              '/usr/local/bin/node',
              guard?.path,
            ],
            timeout: 10,
            onFailure: 'block',
          },
        ],
      },
    ]);
  });

  it("is installed as Claude Code's managed settings file", async () => {
    const files = await readManagedFiles();

    expect(files).toContainEqual({
      provider: 'claude_code',
      source: 'claude-managed-settings.json',
      path: '/etc/claude-code/managed-settings.json',
    });
    // Strict JSON: a broken managed file stops every Claude Code session.
    expect(() =>
      JSON.parse(
        readFileSync(
          new URL('../../guardrails/claude-managed-settings.json', import.meta.url),
          'utf8',
        ),
      ),
    ).not.toThrow();
  });
});

describe("Studio's PreToolUse hook", () => {
  // The step's temporary directory is /data/runs/r1/tmp: beside the Working copy.
  const env = { projectDir: '/data/runs/r1/repo', home: '/home/agent' };
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

  it('blocks a command given as a list of words (Codex)', () => {
    expect(decide({ tool_name: 'Bash', tool_input: { command: ['git', 'push'] } }, env)).toEqual(
      expect.any(String),
    );
    // A shell's script argument is checked as the command it is.
    for (const command of [
      ['bash', '-lc', 'npm test && git push'],
      ['/bin/sh', '-c', 'sudo true'],
    ]) {
      expect(decide({ tool_name: 'Bash', tool_input: { command } }, env)).toEqual(
        expect.any(String),
      );
    }
    expect(
      decide({ tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'npm test'] } }, env),
    ).toBeNull();
  });
});

describe("Studio's PreToolUse hook run by Codex (Issue #134)", () => {
  // Codex gives no CLAUDE_PROJECT_DIR: the session's working directory (the Working copy) is
  // `cwd` in the hook input. File edits are `apply_patch` with the patch as `command`.
  const env = { home: '/home/agent' };
  const codex = (tool_name: string, command: string) =>
    decide({ tool_name, tool_input: { command }, cwd: '/data/runs/r1/repo' }, env);
  const patch = (...headers: string[]) =>
    ['*** Begin Patch', ...headers.flatMap((header) => [header, '+x']), '*** End Patch'].join('\n');

  it('applies the command checks to Codex shell commands', () => {
    expect(codex('Bash', 'git push origin main')).toEqual(expect.any(String));
    expect(codex('Bash', 'DOCKER_HOST=unix:///x.sock touch probe.txt')).toEqual(expect.any(String));
    expect(codex('Bash', 'cat ~/.codex/auth.json')).toEqual(expect.any(String));
    expect(codex('Bash', 'pnpm test')).toBeNull();
  });

  it('lets a patch change files only inside the Working copy or the temporary directory', () => {
    expect(codex('apply_patch', patch('*** Update File: src/a.ts'))).toBeNull();
    expect(codex('apply_patch', patch('*** Add File: /data/runs/r1/repo/b.ts'))).toBeNull();
    expect(codex('apply_patch', patch('*** Add File: /data/runs/r1/tmp/scratch.txt'))).toBeNull();
    for (const header of [
      '*** Add File: /etc/hosts',
      '*** Update File: ../codex/prompt.md',
      '*** Delete File: /home/agent/.bashrc',
    ]) {
      expect(codex('apply_patch', patch('*** Update File: src/a.ts', header))).toEqual(
        expect.any(String),
      );
    }
    expect(
      codex('apply_patch', patch('*** Update File: src/a.ts', '*** Move to: /home/agent/x.ts')),
    ).toEqual(expect.any(String));
  });

  it('checks a patch run through the shell too', () => {
    expect(codex('Bash', `apply_patch <<'EOF'\n${patch('*** Add File: /etc/hosts')}\nEOF`)).toEqual(
      expect.any(String),
    );
    expect(
      codex('Bash', `apply_patch <<'EOF'\n${patch('*** Add File: src/b.ts')}\nEOF`),
    ).toBeNull();
  });

  it('keeps the logins out of reach of a patch', () => {
    expect(codex('apply_patch', patch('*** Add File: /home/agent/.ssh/authorized_keys'))).toEqual(
      expect.any(String),
    );
  });
});
