import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsBlobsResult,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../../projects/contracts/index.js';
import { ReadAgentFolderHandler } from '../handler.js';

const COMMIT = 'a'.repeat(40);
const ENTRY = '---\nname: reviewer\ndescription: Reviews\nprovider: codex\n---\nDo it.\n';

const entry = (path: string, size = 10, executable = false): DefinitionsTreeEntry => ({
  path,
  kind: 'file',
  size,
  executable,
});

interface Script {
  entries?: DefinitionsTreeEntry[];
  tree?: DefinitionsTreeResult;
  blobs?: Record<string, Uint8Array>;
  readFiles?: DefinitionsFilesResult;
  readBlobs?: DefinitionsBlobsResult;
}

function folders(script: Script) {
  const blobs = script.blobs ?? {};
  const fake = {
    snapshot: vi.fn(() => Promise.resolve(null)),
    listTree: vi.fn((): Promise<DefinitionsTreeResult> =>
      Promise.resolve(
        script.tree ?? { status: 'listed', entries: script.entries ?? [], truncated: false },
      ),
    ),
    readFiles: vi.fn((_commit: string, paths: readonly string[]): Promise<DefinitionsFilesResult> =>
      Promise.resolve(
        script.readFiles ?? {
          status: 'read',
          files: paths.map((path) =>
            path === 'agents/reviewer/AGENT.md'
              ? {
                  path,
                  status: 'found' as const,
                  text: ENTRY,
                  size: ENTRY.length,
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
            path in blobs
              ? { path, status: 'found' as const, bytes: blobs[path]! }
              : { path, status: 'missing' as const },
          ),
        },
      ),
    ),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  return { fake, handler: new ReadAgentFolderHandler(fake) };
}

const REVIEWER = [
  entry('agents/reviewer/AGENT.md', 60),
  entry('agents/reviewer/scripts/run.sh', 4, true),
  entry('agents/reviewer/assets/logo.png', 4),
  entry('agents/other/AGENT.md', 10),
  entry('agents/other/leak.txt', 10),
];

describe('ReadAgentFolderHandler', () => {
  it('answers the folder of the named agent without AGENT.md, with bytes and the executable bit', async () => {
    const png = new Uint8Array([0x89, 0x50, 0xff, 0x00]);
    const sh = new TextEncoder().encode('#!/b');
    const { handler, fake } = folders({
      entries: REVIEWER,
      blobs: { 'agents/reviewer/scripts/run.sh': sh, 'agents/reviewer/assets/logo.png': png },
    });

    const result = await handler.execute({ name: 'reviewer', commit: COMMIT });

    expect(result).toEqual({
      status: 'found',
      files: [
        { path: 'assets/logo.png', executable: false, content: png },
        { path: 'scripts/run.sh', executable: true, content: sh },
      ],
    });
    expect(fake.listTree).toHaveBeenCalledWith(COMMIT);
    // The entry file is read as text for the validation only; the other folders are never read.
    expect(fake.readFiles).toHaveBeenCalledWith(
      COMMIT,
      ['agents/reviewer/AGENT.md'],
      expect.any(Number),
    );
    expect(fake.readBlobs.mock.calls[0]![1]).toEqual([
      'agents/reviewer/assets/logo.png',
      'agents/reviewer/scripts/run.sh',
    ]);
  });

  it('answers an empty folder for an agent with the entry file only', async () => {
    const { handler } = folders({ entries: [entry('agents/reviewer/AGENT.md', 60)] });

    await expect(handler.execute({ name: 'reviewer', commit: COMMIT })).resolves.toEqual({
      status: 'found',
      files: [],
    });
  });

  it('refuses a folder that fails the shared validation, with its problems', async () => {
    const { handler, fake } = folders({
      entries: [
        ...REVIEWER,
        entry('agents/reviewer/.claude/settings.json'),
        entry('agents/reviewer/CLAUDE.md'),
      ],
    });

    const result = await handler.execute({ name: 'reviewer', commit: COMMIT });

    expect(result).toMatchObject({ status: 'invalid' });
    if (result.status !== 'invalid') throw new Error('accepted');
    expect(result.problems.map((problem) => `${problem.code}@${problem.path}`).sort()).toEqual([
      'cli_config_path@.claude/settings.json',
      'cli_config_path@CLAUDE.md',
    ]);
    expect(fake.readBlobs).not.toHaveBeenCalled();
  });

  it('refuses a symbolic link as the validation does', async () => {
    const { handler } = folders({
      entries: [
        entry('agents/reviewer/AGENT.md', 60),
        { path: 'agents/reviewer/link', kind: 'symlink', size: 0, executable: false },
      ],
    });

    await expect(handler.execute({ name: 'reviewer', commit: COMMIT })).resolves.toMatchObject({
      status: 'invalid',
    });
  });

  it.each([
    ['no folder of that name at the commit', { entries: [entry('agents/other/AGENT.md')] }],
    ['a commit the Clone lacks', { tree: { status: 'commit_missing' } as DefinitionsTreeResult }],
    ['a Clone that is gone', { tree: { status: 'repository_not_ready' } as DefinitionsTreeResult }],
    [
      'an entry file of a commit the Clone lacks',
      { entries: REVIEWER, readFiles: { status: 'commit_missing' } as DefinitionsFilesResult },
    ],
    [
      'blobs of a commit the Clone lacks',
      { entries: REVIEWER, readBlobs: { status: 'commit_missing' } as DefinitionsBlobsResult },
    ],
    [
      'a file that vanished',
      {
        entries: REVIEWER,
        readBlobs: {
          status: 'read',
          files: [{ path: 'agents/reviewer/assets/logo.png', status: 'missing' }],
        } as DefinitionsBlobsResult,
      },
    ],
  ])('is unavailable for %s', async (_what, script: Script) => {
    const { handler } = folders(script);

    await expect(handler.execute({ name: 'reviewer', commit: COMMIT })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it.each([
    ['a failed tree', { tree: { status: 'failed' } as DefinitionsTreeResult }],
    [
      'an unsupported platform',
      { tree: { status: 'unsupported_platform' } as DefinitionsTreeResult },
    ],
    [
      'a failed read of the entry file',
      { entries: REVIEWER, readFiles: { status: 'failed' } as DefinitionsFilesResult },
    ],
    [
      'failed reads of the blobs',
      { entries: REVIEWER, readBlobs: { status: 'failed' } as DefinitionsBlobsResult },
    ],
  ])(
    'is unreadable, not unavailable, for %s: the commit may well be there',
    async (_what, script: Script) => {
      const { handler } = folders(script);

      await expect(handler.execute({ name: 'reviewer', commit: COMMIT })).resolves.toEqual({
        status: 'unreadable',
        reason: 'read_failed',
      });
    },
  );

  it('is unreadable with the cut as the reason when a cut listing may hold the folder only in part', async () => {
    const { handler } = folders({
      tree: { status: 'listed', entries: REVIEWER.slice(0, 3), truncated: true },
    });

    await expect(handler.execute({ name: 'reviewer', commit: COMMIT })).resolves.toEqual({
      status: 'unreadable',
      reason: 'tree_cut',
    });
  });

  it('still reads a folder that a cut listing holds whole', async () => {
    const { handler } = folders({
      tree: {
        status: 'listed',
        entries: [entry('agents/reviewer/AGENT.md', 60), entry('agents/zeta/AGENT.md')],
        truncated: true,
      },
    });

    await expect(handler.execute({ name: 'reviewer', commit: COMMIT })).resolves.toEqual({
      status: 'found',
      files: [],
    });
  });
});
