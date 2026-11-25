import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArguments, claudeStepFiles } from '../claude-code/cli-options.js';
import { codexHome } from '../codex/codex-home.js';
import { codexStartArguments, codexStepFiles } from '../codex/cli-options.js';
import { AGENT_DIRECTORY_NAME, runDirectories, runsDirectory } from '../run-layout.js';

// Where the agent's files sit decides whether a CLI reads them by itself. Neither CLI may: it reads
// them only when the instructions name them.

const DATA_DIR = '/var/lib/studio-agent';
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const HOME = '/home/agent';

const paths = runDirectories(DATA_DIR, RUN_ID);
const agent = paths.agentDir;

/** Every directory name under which a CLI discovers configuration, skills or agents on its own. */
const DISCOVERED_NAMES = [
  '.claude',
  '.codex',
  '.agents',
  'skills',
  'agents',
  'commands',
  'rules',
  'plugins',
  'hooks',
];

const isInside = (path: string, directory: string) =>
  path === directory || path.startsWith(`${directory}/`);

describe('where the agent folder is', () => {
  it('is agent/ in the Run directory, beside the Working copy', () => {
    expect(agent).toBe(`${DATA_DIR}/runs/${RUN_ID}/agent`);
    expect(AGENT_DIRECTORY_NAME).toBe('agent');
    expect(posix.dirname(agent)).toBe(paths.runDir);
    expect(posix.dirname(paths.repoDir)).toBe(paths.runDir);
  });

  it('is outside the Working copy, and the Working copy is not inside it', () => {
    expect(isInside(agent, paths.repoDir)).toBe(false);
    expect(isInside(paths.repoDir, agent)).toBe(false);
  });

  it('is on no path a CLI walks from the Working copy: not a parent of it, not the Run or runs directory', () => {
    // Claude Code reads CLAUDE.md along the parents of its working directory, Codex AGENTS.md up to
    // the Git root; the folder is a sibling of the Working copy, never one of those parents.
    const parents: string[] = [];
    for (let up = posix.dirname(paths.repoDir); up !== '/'; up = posix.dirname(up))
      parents.push(up);
    expect(parents).toContain(paths.runDir);
    expect(parents).toContain(runsDirectory(DATA_DIR));
    expect(parents).not.toContain(agent);
  });

  it('has no directory a CLI discovers by itself anywhere on its path below the data directory', () => {
    const below = agent.slice(DATA_DIR.length + 1).split('/');
    for (const name of DISCOVERED_NAMES) expect(below).not.toContain(name);
  });

  it('is under no directory the Run steps keep: not the plugin directory, the settings, the instructions, the step files or any temporary directory', () => {
    const claude = claudeStepFiles(paths.runDir);
    const codex = codexStepFiles(paths.runDir);
    const others = [
      claude.pluginDir,
      claude.settingsFile,
      claude.instructionsFile,
      claude.tmpDir,
      codex.dir,
      codex.tmpDir,
      paths.processesFile,
      posix.join(paths.runDir, 'push.git'),
    ];
    for (const other of others) {
      expect(isInside(agent, other), other).toBe(false);
      expect(isInside(other, agent), other).toBe(false);
    }
  });

  it('is under no home directory a CLI reads: not ~/.claude, ~/.codex (CODEX_HOME), ~/.agents', () => {
    for (const root of [`${HOME}/.claude`, codexHome(HOME), `${HOME}/.agents`, HOME]) {
      expect(isInside(agent, root), root).toBe(false);
    }
    expect(codexHome(HOME)).toBe(`${HOME}/.codex`);
  });
});

describe('what the CLIs are given', () => {
  it('names the folder in no Claude Code option', () => {
    const files = claudeStepFiles(paths.runDir);
    const args = claudeArguments({
      prompt: 'The task',
      allowedTools: ['Read'],
      settingsFile: files.settingsFile,
      instructionsFile: files.instructionsFile,
      maxTurns: 10,
      jsonSchema: '{}',
      pluginDir: files.pluginDir,
    });

    expect(args.join('\n')).not.toContain(agent);
    expect(args).not.toContain('--add-dir');
    // The only directory option is the repository plugin, which is not the agent folder.
    expect(args.filter((arg) => arg.startsWith('--') && /dir/i.test(arg))).toEqual([
      '--plugin-dir',
    ]);
  });

  it('names the folder in no Codex option, and gives it no writable root', () => {
    const args = codexStartArguments({
      workingCopy: paths.repoDir,
      sandbox: 'workspace-write',
      files: codexStepFiles(paths.runDir),
    });

    expect(args.join('\n')).not.toContain(agent);
    expect(args).not.toContain('--add-dir');
    expect(args.join('\n')).not.toMatch(/writable_roots/);
  });
});

describe('the worker never runs what it places', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'agent-folder.ts'), 'utf8');

  it.each([
    'node:child_process',
    'child_process',
    './spawn-boundary',
    './process-runner',
    './git',
    'node:vm',
    'node:worker_threads',
  ])('does not import %s', (name) => {
    expect(source).not.toContain(`'${name}`);
  });

  it('calls no exec, spawn, fork, require or dynamic import, and changes modes only to its own constants', () => {
    expect(source).not.toMatch(/\b(exec|execFile|spawn|fork|require|eval)\s*\(/);
    expect(source).not.toMatch(/import\s*\(/);
    const chmods = source.match(/chmod\([^)]*\)/g) ?? [];
    expect(chmods.length).toBeGreaterThan(0);
    for (const call of chmods) expect(call).toMatch(/_MODE|\bmode\b/);
    expect(source).not.toMatch(/\bchmod\w*\s*\(\s*[^,]+,\s*0o/);
  });
});
