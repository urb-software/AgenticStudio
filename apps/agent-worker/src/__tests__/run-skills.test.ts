import type { RunPayload, RunSkillsResponse } from '@agentic-studio/contracts';
import {
  RUN_SKILL_FILES_MAX,
  RUN_SKILLS_MAX,
  RUN_SKILLS_MAX_BYTES,
  runSkillsResponseSchema,
  WORKER_PROBLEM_TYPES,
} from '@agentic-studio/contracts';
import { MAX_AGENT_SKILLS, MAX_FILES } from '@agentic-studio/agent-definitions';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunSkillsApi, RunSkills, SkillsUnusableError, skillsNotices } from '../run-skills.js';
import { StudioApiError } from '../studio-api.js';
import { agentFields } from './agent-fixtures.js';

const RUN_ID = '0b8e5c2d-1f3a-4d6e-9a7b-2c4d6e8f0a1b';
const COMMIT = 'c'.repeat(40);
const linux = process.platform === 'linux';

const b64 = (text: string | Buffer) => Buffer.from(text).toString('base64');
const file = (path: string, content: string | Buffer, executable = false) => ({
  path,
  executable,
  contentBase64: b64(content),
});
const SKILL = (name: string, description = `Does ${name}`, extra = '') =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\nHow to ${name}.\n`;
const skill = (name: string, ...more: ReturnType<typeof file>[]) => ({
  name,
  files: [file('SKILL.md', SKILL(name)), ...more],
});

const run = (
  skills: { name: string; description: string }[] = [
    { name: 'lint', description: 'Does lint' },
    { name: 'notes', description: 'Does notes' },
  ],
  commit: string | null = COMMIT,
): Pick<RunPayload, 'runId' | 'agent' | 'skills'> => ({
  runId: RUN_ID,
  agent:
    commit === null
      ? agentFields().agent
      : {
          name: 'reviewer',
          source: 'definitions',
          commit,
          provider: 'claude_code',
          model: 'default',
          instructions: 'Review.',
        },
  skills,
});

const entries = (path: string): string[] => (existsSync(path) ? readdirSync(path) : []);

describe('RunSkills', () => {
  let root: string;
  let dir: string;
  let answer: RunSkillsResponse | Error;
  let runSkills: ReturnType<typeof vi.fn<RunSkillsApi['runSkills']>>;
  let skills: RunSkills;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'studio-run-skills-'));
    dir = join(root, 'skills');
    answer = { commit: COMMIT, skills: [skill('lint'), skill('notes')], omitted: [] };
    runSkills = vi.fn<RunSkillsApi['runSkills']>(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
    );
    skills = new RunSkills({ api: { runSkills } });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const place = (target = run()) => skills.place(target, dir, new AbortController().signal);

  it('writes each skill below skills/<name>/, bytes unchanged, and answers where each entry file is', async () => {
    const png = Buffer.from([0x89, 0x50, 0xff, 0x00, 0xfe]);
    answer = {
      commit: COMMIT,
      skills: [
        skill('lint', file('scripts/run.sh', '#!/bin/sh\necho hi\n', true), file('logo.png', png)),
        skill('notes'),
      ],
      omitted: [],
    };

    const placed = await place();

    expect(placed).toEqual({
      dir,
      skills: [
        { name: 'lint', description: 'Does lint', entryFile: join(dir, 'lint', 'SKILL.md') },
        { name: 'notes', description: 'Does notes', entryFile: join(dir, 'notes', 'SKILL.md') },
      ],
      omitted: [],
    });
    expect((await readFile(join(dir, 'lint', 'logo.png'))).equals(png)).toBe(true);
    expect(await readFile(join(dir, 'lint', 'scripts', 'run.sh'), 'utf8')).toBe(
      '#!/bin/sh\necho hi\n',
    );
    expect(await readFile(join(dir, 'notes', 'SKILL.md'), 'utf8')).toBe(SKILL('notes'));
    expect(runSkills).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal));
  });

  it.skipIf(!linux)('gives files 0644, an executable one 0755, and directories 0755', async () => {
    answer = {
      commit: COMMIT,
      skills: [skill('lint', file('scripts/run.sh', 'x', true), file('a.txt', 'y'))],
      omitted: [],
    };

    await place(run([{ name: 'lint', description: 'Does lint' }]));

    const mode = async (path: string) => (await stat(join(dir, path))).mode & 0o777;
    expect(await mode('lint/scripts/run.sh')).toBe(0o755);
    expect(await mode('lint/a.txt')).toBe(0o644);
    expect(await mode('lint/SKILL.md')).toBe(0o644);
    expect(await mode('.')).toBe(0o755);
    expect(await mode('lint')).toBe(0o755);
    expect(await mode('lint/scripts')).toBe(0o755);
  });

  it('deletes the folder and writes it fresh: what the agent changed or added is gone', async () => {
    await place();
    await writeFile(join(dir, 'lint', 'SKILL.md'), 'tampered by the agent');
    await mkdir(join(dir, 'planted'));
    await writeFile(join(dir, 'planted', 'extra.sh'), 'x');
    await writeFile(join(dir, 'notes', 'new.md'), 'added');

    await place();

    expect(await readFile(join(dir, 'lint', 'SKILL.md'), 'utf8')).toBe(SKILL('lint'));
    expect((await readdir(dir)).sort()).toEqual(['lint', 'notes']);
    expect(await readdir(join(dir, 'notes'))).toEqual(['SKILL.md']);
  });

  it.skipIf(!linux)('does not follow a link the agent planted when it rebuilds', async () => {
    await place();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'keep');
    await symlink(outside, join(dir, 'lint', 'link'));
    await symlink(root, join(dir, 'dirlink'));

    await place();

    expect(await readFile(outside, 'utf8')).toBe('keep');
    expect((await readdir(dir)).sort()).toEqual(['lint', 'notes']);
    expect((await readdir(join(dir, 'lint'))).sort()).toEqual(['SKILL.md']);
  });

  it.skipIf(!linux)('replaces a link at the folder itself without following it', async () => {
    const elsewhere = join(root, 'elsewhere');
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, 'keep.txt'), 'keep');
    await symlink(elsewhere, dir);

    await place();

    expect((await lstat(dir)).isSymbolicLink()).toBe(false);
    expect(await readdir(elsewhere)).toEqual(['keep.txt']);
  });

  it('asks nothing and writes nothing for a Run without skills, and removes a stale folder', async () => {
    await mkdir(dir);
    await writeFile(join(dir, 'stale.txt'), 'x');

    await expect(place(run([]))).resolves.toBeNull();
    await expect(place({ ...run([]), skills: undefined })).resolves.toBeNull();
    await expect(place(run([], null))).resolves.toBeNull();

    expect(runSkills).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  it('leaves out of the folder the skills the hand-over omitted, and reports them', async () => {
    answer = { commit: COMMIT, skills: [skill('lint')], omitted: ['notes'] };

    const placed = await place();

    expect(placed?.skills.map((item) => item.name)).toEqual(['lint']);
    expect(placed?.omitted).toEqual(['notes']);
    expect(await readdir(dir)).toEqual(['lint']);
  });

  it('writes no folder when every skill was omitted', async () => {
    answer = { commit: COMMIT, skills: [], omitted: ['lint', 'notes'] };

    const placed = await place();

    expect(placed).toEqual({ dir, skills: [], omitted: ['lint', 'notes'] });
    expect(existsSync(dir)).toBe(false);
  });

  it.each([
    ['a path that leaves the folder', [file('../escape.sh', 'x')]],
    ['an absolute path', [file('/etc/cron.d/x', 'x')]],
    ['a hidden path', [file('.claude/settings.json', '{}')]],
    ['a CLI instruction file', [file('docs/CLAUDE.md', 'x')]],
    ['a second SKILL.md below the root', [file('nested/SKILL.md', SKILL('lint'))]],
    ['an agent entry file', [file('AGENT.md', '---\nname: x\n---\n')]],
    ['a path inside a Git directory', [file('a/.git/config', 'x')]],
    ['two paths that differ in case', [file('A.txt', 'a'), file('a.txt', 'b')]],
    ['a file over the size limit', [file('big.bin', Buffer.alloc(1024 * 1024 + 1))]],
    ['a Markdown file with a shell line', [file('more.md', 'Run !`id` now.\n')]],
  ])('refuses %s and writes nothing', async (_what, more) => {
    answer = { commit: COMMIT, skills: [skill('lint', ...more), skill('notes')], omitted: [] };

    await expect(place()).rejects.toThrow(SkillsUnusableError);

    expect(existsSync(dir)).toBe(false);
    expect(entries(root)).toEqual([]);
  });

  it('refuses a SKILL.md that fails the shared validation, and says which skill', async () => {
    answer = {
      commit: COMMIT,
      skills: [
        skill('lint'),
        { name: 'notes', files: [file('SKILL.md', SKILL('notes', 'Does notes', 'hooks: x\n'))] },
      ],
      omitted: [],
    };

    const error = await place().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SkillsUnusableError);
    expect((error as SkillsUnusableError).detail).toMatch(/notes/);
    expect((error as SkillsUnusableError).detail).toMatch(/forbidden_key/);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a skill without its SKILL.md, or named differently from the claim', async () => {
    answer = {
      commit: COMMIT,
      skills: [{ name: 'lint', files: [file('a.txt', 'x')] }, skill('notes')],
      omitted: [],
    };
    await expect(place()).rejects.toThrow(SkillsUnusableError);

    answer = { commit: COMMIT, skills: [skill('notes'), skill('lint')], omitted: [] };
    await expect(place()).rejects.toThrow(SkillsUnusableError);

    answer = { commit: COMMIT, skills: [skill('lint')], omitted: [] };
    await expect(place()).rejects.toThrow(SkillsUnusableError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a description in the files that differs from the one the claim carried', async () => {
    await expect(
      place(
        run([
          { name: 'lint', description: 'Another description' },
          { name: 'notes', description: 'Does notes' },
        ]),
      ),
    ).rejects.toThrow(SkillsUnusableError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses content that is not canonical base64', async () => {
    answer = {
      commit: COMMIT,
      skills: [
        { name: 'lint', files: [{ path: 'SKILL.md', executable: false, contentBase64: 'QR==' }] },
      ],
      omitted: ['notes'],
    };

    await expect(place()).rejects.toThrow(SkillsUnusableError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a hand-over that names another commit than the Run recorded', async () => {
    answer = { commit: 'd'.repeat(40), skills: [skill('lint'), skill('notes')], omitted: [] };

    await expect(place()).rejects.toThrow(SkillsUnusableError);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses skills past the byte budget the hand-over should have cut', async () => {
    const piece = Buffer.alloc(1024 * 1024, 'a');
    const heavy = (name: string) => ({
      name,
      files: [file('SKILL.md', SKILL(name)), ...[1, 2, 3, 4].map((n) => file(`d${n}.bin`, piece))],
    });
    const names = ['s1', 's2', 's3', 's4', 's5'];
    answer = { commit: COMMIT, skills: names.map(heavy), omitted: [] };

    await expect(
      place(run(names.map((name) => ({ name, description: `Does ${name}` })))),
    ).rejects.toThrow(/budget|too large|total/i);
    expect(RUN_SKILLS_MAX_BYTES).toBeLessThan(5 * 4 * 1024 * 1024 + 1);
    expect(existsSync(dir)).toBe(false);
  });

  it('keeps an earlier folder when the new hand-over is refused', async () => {
    await place();
    answer = {
      commit: COMMIT,
      skills: [skill('lint', file('../x', 'two')), skill('notes')],
      omitted: [],
    };

    await expect(place()).rejects.toThrow(SkillsUnusableError);

    expect(await readFile(join(dir, 'lint', 'SKILL.md'), 'utf8')).toBe(SKILL('lint'));
  });

  it('turns every refusal and failure of the route into a clear skills_unusable reason', async () => {
    const problem = (status: number, type?: string) =>
      new StudioApiError(status, '/api/worker/runs/x/skills', type);
    const reasons: [Error, RegExp][] = [
      [problem(409, WORKER_PROBLEM_TYPES.skillsUnavailable), /no longer available/],
      [problem(409, WORKER_PROBLEM_TYPES.skillsInvalid), /invalid/],
      [problem(503), /could not be fetched.*try again/is],
      [problem(500), /could not be fetched/],
      [new TypeError('fetch failed'), /could not be fetched/],
      [problem(400), /could not be fetched/],
    ];
    for (const [failure, reason] of reasons) {
      answer = failure;
      const error = await place().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SkillsUnusableError);
      expect((error as SkillsUnusableError).detail).toMatch(reason);
    }
  });

  it('keeps a loss of the Run as it is: the worker own loss handling decides', async () => {
    for (const [status, type] of [
      [404, undefined],
      [409, WORKER_PROBLEM_TYPES.runNotHeld],
    ] as const) {
      const lost = new StudioApiError(status, '/api/worker/runs/x/skills', type);
      answer = lost;
      await expect(place()).rejects.toBe(lost);
    }
  });

  it('fails a malformed hand-over as unusable, not as an outage', async () => {
    const failure = await runSkillsResponseSchema
      .parseAsync({ commit: 'main', skills: [], omitted: [] })
      .catch((error: unknown) => error);
    answer = failure as Error;

    const error = await place().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SkillsUnusableError);
    expect((error as SkillsUnusableError).detail).toMatch(/malformed/);
  });

  it('keeps the reason of a stop: an aborted call is not a failure of the skills', async () => {
    const stop = new AbortController();
    stop.abort(new Error('stopped'));
    answer = new DOMException('aborted', 'AbortError');

    await expect(skills.place(run(), dir, stop.signal)).rejects.toThrow('aborted');
  });

  it('lists the Git blob ids of the non-empty files with their path, for both hash functions', async () => {
    const content = 'a script\n';
    answer = {
      commit: COMMIT,
      skills: [skill('lint', file('run.sh', content), file('empty.txt', '')), skill('notes')],
      omitted: [],
    };

    const blobs = await skills.placedBlobs(run(), new AbortController().signal);

    const sha1 = createHash('sha1').update(`blob ${content.length}\0${content}`).digest('hex');
    const sha256 = createHash('sha256').update(`blob ${content.length}\0${content}`).digest('hex');
    expect(blobs.get(sha1)).toBe('skills/lint/run.sh');
    expect(blobs.get(sha256)).toBe('skills/lint/run.sh');
    expect([...blobs.values()]).not.toContain('skills/lint/empty.txt');
    expect([...blobs.values()]).toContain('skills/notes/SKILL.md');
    expect(existsSync(dir)).toBe(false);
  });

  it('lists no blob for a Run without skills, asking nothing', async () => {
    const blobs = await skills.placedBlobs(run([]), new AbortController().signal);

    expect(blobs.size).toBe(0);
    expect(runSkills).not.toHaveBeenCalled();
  });
});

describe('the log lines about skills', () => {
  const dir = '/runs/x/skills';
  const skill = (name: string) => ({
    name,
    description: `Secret description of ${name}`,
    entryFile: `${dir}/${name}/SKILL.md`,
  });

  it('name the skills placed and those left out, never a description or a path', () => {
    const notices = skillsNotices({
      dir,
      skills: [skill('lint'), skill('notes')],
      omitted: ['big'],
    });

    expect(notices).toEqual([
      'Skills: lint, notes',
      'Skills left out because their files pass 20 MiB in total: big',
    ]);
    expect(notices.join(' ')).not.toMatch(/Secret|\/runs\//);
  });

  it('are none for no skills', () => {
    expect(skillsNotices({ dir, skills: [], omitted: [] })).toEqual([]);
  });
});

describe('the limits of the hand-over', () => {
  it('are the limits of the definitions package, which the wire repeats', () => {
    expect(RUN_SKILLS_MAX).toBe(MAX_AGENT_SKILLS);
    expect(RUN_SKILL_FILES_MAX).toBe(MAX_FILES);
  });
});
