import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsFileRead,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
} from '../../../../../projects/contracts/index.js';
import { ReadAgentFileHandler } from '../handler.js';

const COMMIT = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

type Unavailable = Exclude<DefinitionsFilesResult['status'], 'read'>;

function scripted(script: {
  snapshot?: DefinitionsSnapshot | null;
  read?: DefinitionsFileRead;
  unavailable?: Unavailable;
}) {
  const fake = {
    snapshot: vi.fn(() =>
      Promise.resolve(
        script.snapshot === undefined
          ? { state: 'ready' as const, commit: COMMIT }
          : script.snapshot,
      ),
    ),
    listTree: vi.fn(() => Promise.reject(new Error('not used'))),
    readFiles: vi.fn((_c: string, paths: readonly string[]): Promise<DefinitionsFilesResult> => {
      if (script.unavailable) return Promise.resolve({ status: script.unavailable });
      const read = script.read ?? { path: paths[0]!, status: 'missing' as const, size: 0 };
      return Promise.resolve({ status: 'read', files: [{ ...read, path: paths[0]! }] });
    }),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  return { fake, handler: new ReadAgentFileHandler(fake) };
}

const found = (
  text: string,
  size = Buffer.byteLength(text),
  binary = false,
): DefinitionsFileRead => ({ path: 'x', status: 'found', text, size, binary });

describe('ReadAgentFileHandler', () => {
  it('reads a text file at the current commit with the package file limit', async () => {
    const { handler, fake } = scripted({ read: found('# Title\n') });

    await expect(handler.execute({ path: 'agents/a/AGENT.md' })).resolves.toEqual({
      status: 'read',
      commit: COMMIT,
      path: 'agents/a/AGENT.md',
      content: { kind: 'text', content: '# Title\n' },
    });
    expect(fake.readFiles).toHaveBeenCalledWith(COMMIT, ['agents/a/AGENT.md'], MAX_FILE_BYTES);
  });

  it('reads at the commit asked for', async () => {
    const { handler, fake } = scripted({ read: found('old') });

    const result = await handler.execute({ path: 'a.txt', commit: OTHER });

    expect(result).toMatchObject({ status: 'read', commit: OTHER });
    expect(fake.readFiles).toHaveBeenCalledWith(OTHER, ['a.txt'], MAX_FILE_BYTES);
  });

  it('reads at the commit asked for even when the snapshot has no commit', async () => {
    const { handler } = scripted({
      snapshot: { state: 'failed', commit: null },
      read: found('old'),
    });

    await expect(handler.execute({ path: 'a.txt', commit: OTHER })).resolves.toMatchObject({
      status: 'read',
    });
  });

  it('keeps an empty text file as text', async () => {
    const { handler } = scripted({ read: found('') });

    await expect(handler.execute({ path: 'empty.txt' })).resolves.toMatchObject({
      content: { kind: 'text', content: '' },
    });
  });

  it('keeps valid UTF-8 text, also multi-byte, as text', async () => {
    const { handler } = scripted({ read: found('zażółć 日本語 😀\n') });

    await expect(handler.execute({ path: 'a.txt' })).resolves.toMatchObject({
      content: { kind: 'text', content: 'zażółć 日本語 😀\n' },
    });
  });

  it('answers a file with a NUL byte as binary, with its size and no content', async () => {
    const { handler } = scripted({ read: found('PK\u0000\u0003', 4, true) });

    await expect(handler.execute({ path: 'a.zip' })).resolves.toEqual({
      status: 'read',
      commit: COMMIT,
      path: 'a.zip',
      content: { kind: 'binary', size: 4 },
    });
  });

  it('answers a file the read marks binary as binary, with the real size, also a big one', async () => {
    const { handler } = scripted({ read: found('a�b', 700_000, true) });

    await expect(handler.execute({ path: 'a.dat' })).resolves.toMatchObject({
      content: { kind: 'binary', size: 700_000 },
    });
  });

  it('keeps valid UTF-8 text that contains U+FFFD as text', async () => {
    const { handler } = scripted({ read: found('ok � ok') });

    await expect(handler.execute({ path: 'a.log' })).resolves.toMatchObject({
      content: { kind: 'text', content: 'ok � ok' },
    });
  });

  it('answers a file over the limit as too large, with its size', async () => {
    const { handler } = scripted({
      read: { path: 'x', status: 'too_large', size: MAX_FILE_BYTES + 1 },
    });

    await expect(handler.execute({ path: 'big.txt' })).resolves.toMatchObject({
      status: 'read',
      content: { kind: 'too_large', size: MAX_FILE_BYTES + 1 },
    });
  });

  it('answers not found for a path that is no regular file (also a link or a submodule)', async () => {
    const { handler } = scripted({});

    await expect(handler.execute({ path: 'link.md' })).resolves.toEqual({ status: 'not_found' });
  });

  it('is not found when no Repository is connected, or it has no commit', async () => {
    const none = scripted({ snapshot: null });
    await expect(none.handler.execute({ path: 'a.txt' })).resolves.toEqual({
      status: 'not_found',
    });
    const empty = scripted({ snapshot: { state: 'awaiting_key', commit: null } });
    await expect(empty.handler.execute({ path: 'a.txt' })).resolves.toEqual({
      status: 'not_found',
    });
    expect(none.fake.readFiles).not.toHaveBeenCalled();
    expect(empty.fake.readFiles).not.toHaveBeenCalled();
  });

  it('tells a commit the Clone does not hold', async () => {
    const { handler } = scripted({ unavailable: 'commit_missing' });

    await expect(handler.execute({ path: 'a.txt', commit: OTHER })).resolves.toEqual({
      status: 'commit_missing',
    });
  });

  it.each(['unsupported_platform', 'failed'] as const)('reports %s as unreadable', async (why) => {
    const { handler } = scripted({ unavailable: why });

    await expect(handler.execute({ path: 'a.txt' })).resolves.toEqual({ status: 'unreadable' });
  });

  it('treats a Clone that is gone as not found', async () => {
    const { handler } = scripted({ unavailable: 'repository_not_ready' });

    await expect(handler.execute({ path: 'a.txt' })).resolves.toEqual({ status: 'not_found' });
  });
});
