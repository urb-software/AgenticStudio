import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsBlobsResult,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../../projects/contracts/index.js';
import { SkillsReader } from '../../../skills-reader.js';
import { ReadRunSkillsHandler } from '../handler.js';

const COMMIT = 'a'.repeat(40);

const SKILL = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nHow to ${name}.\n`;

const file = (path: string, size = 10, executable = false): DefinitionsTreeEntry => ({
  path,
  kind: 'file',
  size,
  executable,
});

interface Script {
  entries?: DefinitionsTreeEntry[];
  truncated?: boolean;
  tree?: DefinitionsTreeResult;
  texts?: Record<string, string>;
  bytes?: Record<string, Uint8Array>;
  readFiles?: DefinitionsFilesResult;
  readBlobs?: DefinitionsBlobsResult;
}

function build(script: Script) {
  const texts = script.texts ?? {};
  const bytes = script.bytes ?? {};
  const fake = {
    snapshot: vi.fn(() => Promise.resolve({ state: 'ready' as const, commit: COMMIT })),
    listTree: vi.fn((): Promise<DefinitionsTreeResult> =>
      Promise.resolve(
        script.tree ?? {
          status: 'listed',
          entries: script.entries ?? [],
          truncated: script.truncated ?? false,
        },
      ),
    ),
    readFiles: vi.fn((_commit: string, paths: readonly string[]): Promise<DefinitionsFilesResult> =>
      Promise.resolve(
        script.readFiles ?? {
          status: 'read',
          files: paths.map((path) =>
            path in texts
              ? {
                  path,
                  status: 'found' as const,
                  text: texts[path]!,
                  size: texts[path]!.length,
                  binary: false,
                }
              : { path, status: 'missing' as const, size: 0 as const },
          ),
        },
      ),
    ),
    readBlobs: vi.fn((_commit: string, paths: readonly string[]): Promise<DefinitionsBlobsResult> =>
      Promise.resolve(
        script.readBlobs ?? {
          status: 'read',
          files: paths.map((path) =>
            path in bytes
              ? { path, status: 'found' as const, bytes: bytes[path]! }
              : { path, status: 'missing' as const },
          ),
        },
      ),
    ),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  return { fake, handler: new ReadRunSkillsHandler(new SkillsReader(fake), fake) };
}

const TWO_SKILLS: Script = {
  entries: [
    file('skills/lint/SKILL.md', 60),
    file('skills/lint/run.sh', 4, true),
    file('skills/notes/SKILL.md', 60),
  ],
  texts: {
    'skills/lint/SKILL.md': SKILL('lint'),
    'skills/notes/SKILL.md': SKILL('notes'),
  },
  bytes: {
    'skills/lint/SKILL.md': new TextEncoder().encode(SKILL('lint')),
    'skills/lint/run.sh': new TextEncoder().encode('#!/b'),
    'skills/notes/SKILL.md': new TextEncoder().encode(SKILL('notes')),
  },
};

describe('ReadRunSkillsHandler describing', () => {
  it('answers name and description of each named skill, in the order named', async () => {
    const { handler } = build(TWO_SKILLS);

    await expect(
      handler.execute({ include: 'descriptions', names: ['notes', 'lint'], commit: COMMIT }),
    ).resolves.toEqual({
      status: 'found',
      skills: [
        { name: 'notes', description: 'Does notes', files: [] },
        { name: 'lint', description: 'Does lint', files: [] },
      ],
      omitted: [],
    });
  });

  it('reads nothing for no names', async () => {
    const { handler, fake } = build(TWO_SKILLS);

    await expect(
      handler.execute({ include: 'descriptions', names: [], commit: COMMIT }),
    ).resolves.toEqual({ status: 'found', skills: [], omitted: [] });
    expect(fake.listTree).not.toHaveBeenCalled();
  });

  it('is unavailable when a skill is gone at the commit, and when the commit is', async () => {
    const gone = build(TWO_SKILLS);
    await expect(
      gone.handler.execute({ include: 'descriptions', names: ['lint', 'removed'], commit: COMMIT }),
    ).resolves.toEqual({
      status: 'unavailable',
    });

    const missingCommit = build({ tree: { status: 'commit_missing' } });
    await expect(
      missingCommit.handler.execute({ include: 'descriptions', names: ['lint'], commit: COMMIT }),
    ).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('is unreadable, not unavailable, when Git failed', async () => {
    const { handler } = build({ tree: { status: 'failed' } });

    await expect(
      handler.execute({ include: 'descriptions', names: ['lint'], commit: COMMIT }),
    ).resolves.toEqual({ status: 'unreadable' });
  });

  it('is invalid with the problems of the skill the shared validation refuses', async () => {
    const { handler } = build({
      entries: [file('skills/lint/SKILL.md', 60)],
      texts: { 'skills/lint/SKILL.md': SKILL('lint', 'hooks: x\n') },
    });

    const result = await handler.execute({
      include: 'descriptions',
      names: ['lint'],
      commit: COMMIT,
    });

    expect(result).toMatchObject({ status: 'invalid' });
    expect(result.status === 'invalid' && result.problems[0]).toMatchObject({ skill: 'lint' });
  });
});

describe('ReadRunSkillsHandler files', () => {
  it('answers every file of the named skills, SKILL.md included, with the executable bit', async () => {
    const { handler, fake } = build(TWO_SKILLS);

    const result = await handler.execute({
      include: 'files',
      names: ['lint', 'notes'],
      commit: COMMIT,
    });

    expect(result.status).toBe('found');
    if (result.status !== 'found') return;
    expect(result.omitted).toEqual([]);
    expect(result.skills.map((skill) => skill.name)).toEqual(['lint', 'notes']);
    expect(result.skills[0]!.files.map(({ path, executable }) => ({ path, executable }))).toEqual([
      { path: 'SKILL.md', executable: false },
      { path: 'run.sh', executable: true },
    ]);
    expect(fake.readBlobs.mock.calls.map((call) => call[1])).toEqual([
      ['skills/lint/SKILL.md', 'skills/lint/run.sh'],
      ['skills/notes/SKILL.md'],
    ]);
  });

  it('answers nothing, reading nothing, for no names', async () => {
    const { handler, fake } = build(TWO_SKILLS);

    await expect(handler.execute({ include: 'files', names: [], commit: COMMIT })).resolves.toEqual(
      {
        status: 'found',
        skills: [],
        omitted: [],
      },
    );
    expect(fake.readBlobs).not.toHaveBeenCalled();
  });

  it('leaves out the skill that would pass the byte budget and every skill after it', async () => {
    // Four 1 MiB files per skill: four skills fit the budget, the fifth does not.
    const names = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const entries = names.flatMap((name) => [
      file(`skills/${name}/SKILL.md`, 60),
      ...[1, 2, 3, 4].map((n) => file(`skills/${name}/data${n}.bin`, 1024 * 1024)),
    ]);
    const { handler, fake } = build({
      entries,
      texts: Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, SKILL(name)])),
      bytes: Object.fromEntries(entries.map((item) => [item.path, new Uint8Array([1])])),
    });

    const result = await handler.execute({ include: 'files', names, commit: COMMIT });

    expect(result.status === 'found' && result.skills.map((skill) => skill.name)).toEqual(
      names.slice(0, 4),
    );
    expect(result.status === 'found' && result.omitted).toEqual(['s5', 's6']);
    expect(fake.readBlobs).toHaveBeenCalledTimes(4);
  });

  it('is invalid when any named skill fails the validation, even one that would be left out', async () => {
    const { handler } = build({
      entries: [file('skills/aaa/SKILL.md', 60), file('skills/bbb/SKILL.md', 60)],
      texts: {
        'skills/aaa/SKILL.md': SKILL('aaa'),
        'skills/bbb/SKILL.md': SKILL('bbb', 'hooks: x\n'),
      },
    });

    await expect(
      handler.execute({ include: 'files', names: ['aaa', 'bbb'], commit: COMMIT }),
    ).resolves.toMatchObject({
      status: 'invalid',
    });
  });

  it('is unavailable when a file is gone, and unreadable when the blobs cannot be read', async () => {
    const gone = build({ ...TWO_SKILLS, bytes: {} });
    await expect(
      gone.handler.execute({ include: 'files', names: ['lint'], commit: COMMIT }),
    ).resolves.toEqual({
      status: 'unavailable',
    });

    const failed = build({ ...TWO_SKILLS, readBlobs: { status: 'failed' } });
    await expect(
      failed.handler.execute({ include: 'files', names: ['lint'], commit: COMMIT }),
    ).resolves.toEqual({
      status: 'unreadable',
    });
  });

  it('never reads the skill folders it was not asked for', async () => {
    const { handler, fake } = build(TWO_SKILLS);

    await handler.execute({ include: 'files', names: ['notes'], commit: COMMIT });

    expect(fake.readBlobs.mock.calls.flatMap((call) => call[1])).toEqual(['skills/notes/SKILL.md']);
  });
});
