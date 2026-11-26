import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeArguments, claudeStepFiles } from '../claude-code/cli-options.js';
import { codexHome } from '../codex/codex-home.js';
import { codexStartArguments, codexStepFiles } from '../codex/cli-options.js';
import {
  AGENT_DIRECTORY_NAME,
  runDirectories,
  runsDirectory,
  SKILLS_DIRECTORY_NAME,
} from '../run-layout.js';
import { RunSkills } from '../run-skills.js';

// Where the skills sit decides whether a CLI reads them by itself. Neither CLI may: it reads them
// only when the instructions name them.

const DATA_DIR = '/var/lib/studio-agent';
const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const HOME = '/home/agent';

const paths = runDirectories(DATA_DIR, RUN_ID);
const skills = paths.skillsDir;

/**
 * Every directory name under which a CLI discovers configuration, skills or agents on its own.
 * The same list as the agent folder's location test; `skills` is here the name of Studio's own
 * folder, so it is checked as an ancestor only (a CLI looks for `skills` below these others).
 */
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

describe('where the skills are', () => {
  it('is skills/ in the Run directory, beside the Working copy and the agent folder', () => {
    expect(skills).toBe(`${DATA_DIR}/runs/${RUN_ID}/skills`);
    expect(SKILLS_DIRECTORY_NAME).toBe('skills');
    expect(posix.dirname(skills)).toBe(paths.runDir);
    expect(posix.dirname(paths.repoDir)).toBe(paths.runDir);
    expect(posix.dirname(paths.agentDir)).toBe(paths.runDir);
    expect(SKILLS_DIRECTORY_NAME).not.toBe(AGENT_DIRECTORY_NAME);
  });

  it('is outside the Working copy and the agent folder, and neither is inside it', () => {
    for (const other of [paths.repoDir, paths.agentDir]) {
      expect(isInside(skills, other)).toBe(false);
      expect(isInside(other, skills)).toBe(false);
    }
  });

  it('is on no path a CLI walks from the Working copy: not a parent of it, not the Run or runs directory', () => {
    const parents: string[] = [];
    for (let up = posix.dirname(paths.repoDir); up !== '/'; up = posix.dirname(up))
      parents.push(up);
    expect(parents).toContain(paths.runDir);
    expect(parents).toContain(runsDirectory(DATA_DIR));
    expect(parents).not.toContain(skills);
  });

  it('has no directory a CLI discovers by itself among its ancestors below the data directory', () => {
    const ancestors = posix
      .dirname(skills)
      .slice(DATA_DIR.length + 1)
      .split('/');
    for (const name of DISCOVERED_NAMES) expect(ancestors).not.toContain(name);
  });

  it('is under no directory the Run steps keep, and none of them is under it', () => {
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
      expect(isInside(skills, other), other).toBe(false);
      expect(isInside(other, skills), other).toBe(false);
    }
  });

  it('is under no home directory a CLI reads: not ~/.claude, ~/.codex (CODEX_HOME), ~/.agents', () => {
    for (const root of [`${HOME}/.claude`, codexHome(HOME), `${HOME}/.agents`, HOME]) {
      expect(isInside(skills, root), root).toBe(false);
    }
  });
});

describe('what the CLIs are given', () => {
  it('names the skills in no Claude Code option, and adds no directory but the repository plugin', () => {
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

    expect(args.join('\n')).not.toContain(skills);
    expect(args).not.toContain('--add-dir');
    expect(args.filter((arg) => arg.startsWith('--') && /dir/i.test(arg))).toEqual([
      '--plugin-dir',
    ]);
  });

  it('names the skills in no Codex option, and gives them no writable root', () => {
    const args = codexStartArguments({
      workingCopy: paths.repoDir,
      sandbox: 'workspace-write',
      files: codexStepFiles(paths.runDir),
    });

    expect(args.join('\n')).not.toContain(skills);
    expect(args).not.toContain('--add-dir');
    expect(args.join('\n')).not.toMatch(/writable_roots/);
  });
});

describe('the worker never runs what it places', () => {
  const source = ['run-skills.ts', 'placed-files.ts']
    .map((name) => readFileSync(join(import.meta.dirname, '..', name), 'utf8'))
    .join('\n');

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

  it('calls no exec, spawn, fork, require or dynamic import', () => {
    expect(source).not.toMatch(/\b(exec|execFile|spawn|fork|require|eval)\s*\(/);
    expect(source).not.toMatch(/import\s*\(/);
  });

  it('is named as the working directory or the program of no process the worker starts', () => {
    // Every module that starts a process never mentions the skills folder.
    for (const name of ['spawn-boundary.ts', 'process-runner.ts', 'git.ts']) {
      const text = readFileSync(join(import.meta.dirname, '..', name), 'utf8');
      expect(text, name).not.toMatch(/skillsDir|SKILLS_DIRECTORY_NAME/);
    }
  });

  it('runs no script it wrote: a script stays unrun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'studio-run-skills-location-'));
    try {
      const marker = join(root, 'ran');
      const content = Buffer.from(`#!/bin/sh\ntouch '${marker}'\n`).toString('base64');
      const entry = Buffer.from('---\nname: lint\ndescription: Does lint\n---\nGo.\n').toString(
        'base64',
      );
      const commit = 'c'.repeat(40);
      const placed = await new RunSkills({
        api: {
          runSkills: () =>
            Promise.resolve({
              commit,
              skills: [
                {
                  name: 'lint',
                  files: [
                    { path: 'SKILL.md', executable: false, contentBase64: entry },
                    { path: 'run.sh', executable: true, contentBase64: content },
                  ],
                },
              ],
              omitted: [],
            }),
        },
      }).place(
        {
          runId: RUN_ID,
          agent: {
            name: 'reviewer',
            source: 'definitions',
            commit,
            provider: 'codex',
            model: 'default',
            instructions: '',
          },
          skills: [{ name: 'lint', description: 'Does lint' }],
        },
        join(root, 'skills'),
        new AbortController().signal,
      );

      expect(placed?.skills).toHaveLength(1);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
