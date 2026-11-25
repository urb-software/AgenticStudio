import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsFiles,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../../projects/contracts/index.js';
import { AGENT_FILES_MAX_ENTRIES, ListAgentFilesHandler } from '../handler.js';

const COMMIT = 'a'.repeat(40);

function scripted(script: { snapshot?: DefinitionsSnapshot | null; tree?: DefinitionsTreeResult }) {
  const fake = {
    snapshot: vi.fn(() =>
      Promise.resolve(
        script.snapshot === undefined
          ? { state: 'ready' as const, commit: COMMIT }
          : script.snapshot,
      ),
    ),
    listTree: vi.fn((): Promise<DefinitionsTreeResult> =>
      Promise.resolve(script.tree ?? { status: 'listed', entries: [], truncated: false }),
    ),
    readFiles: vi.fn(() => Promise.reject(new Error('not used'))),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  return { fake, handler: new ListAgentFilesHandler(fake) };
}

const file = (path: string, size = 10): DefinitionsTreeEntry => ({ path, kind: 'file', size });
const listed = (entries: DefinitionsTreeEntry[], truncated = false): DefinitionsTreeResult => ({
  status: 'listed',
  entries,
  truncated,
});

describe('ListAgentFilesHandler', () => {
  it('lists the whole tree at the last fetched commit and names the agent of each entry', async () => {
    const { handler, fake } = scripted({
      tree: listed([
        file('README.md', 3),
        file('agents/reviewer/AGENT.md', 40),
        file('agents/reviewer/notes/a.txt', 5),
        { path: 'agents/linked/AGENT.md', kind: 'symlink', size: 0 },
        { path: 'agents/vendored', kind: 'submodule', size: 0 },
        file('agents/stray.txt', 1),
        file('skills/s/SKILL.md', 6),
      ]),
    });

    const result = await handler.execute();

    expect(fake.listTree).toHaveBeenCalledWith(COMMIT, { whole: true });
    expect(result).toEqual({
      commit: COMMIT,
      repository: { state: 'ready', note: null },
      truncated: false,
      entries: [
        { path: 'README.md', kind: 'file', size: 3, agent: null },
        { path: 'agents/reviewer/AGENT.md', kind: 'file', size: 40, agent: 'reviewer' },
        { path: 'agents/reviewer/notes/a.txt', kind: 'file', size: 5, agent: 'reviewer' },
        { path: 'agents/linked/AGENT.md', kind: 'symlink', size: 0, agent: 'linked' },
        { path: 'agents/vendored', kind: 'submodule', size: 0, agent: 'vendored' },
        { path: 'agents/stray.txt', kind: 'file', size: 1, agent: null },
        { path: 'skills/s/SKILL.md', kind: 'file', size: 6, agent: null },
      ],
    });
  });

  it('leaves out an entry of a kind it cannot show', async () => {
    const { handler } = scripted({
      tree: listed([file('a.txt'), { path: 'odd', kind: 'other', size: 0 }]),
    });

    const result = await handler.execute();

    expect(result.entries.map((entry) => entry.path)).toEqual(['a.txt']);
  });

  it('cuts the list at the bound and says so', async () => {
    const entries = Array.from({ length: AGENT_FILES_MAX_ENTRIES + 5 }, (_, i) => file(`f${i}`));
    const { handler } = scripted({ tree: listed(entries) });

    const result = await handler.execute();

    expect(result.entries).toHaveLength(AGENT_FILES_MAX_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it('says so when the Git listing was itself cut', async () => {
    const { handler } = scripted({ tree: listed([file('a')], true) });

    expect((await handler.execute()).truncated).toBe(true);
  });

  it('answers an empty tree and no repository when none is connected', async () => {
    const { handler, fake } = scripted({ snapshot: null });

    await expect(handler.execute()).resolves.toEqual({
      commit: null,
      repository: null,
      truncated: false,
      entries: [],
    });
    expect(fake.listTree).not.toHaveBeenCalled();
  });

  it('explains a Repository without a Clone', async () => {
    const { handler, fake } = scripted({ snapshot: { state: 'awaiting_key', commit: null } });

    const result = await handler.execute();

    expect(result).toMatchObject({ commit: null, entries: [], truncated: false });
    expect(result.repository?.state).toBe('awaiting_key');
    expect(result.repository?.note).toContain('Deploy key');
    expect(fake.listTree).not.toHaveBeenCalled();
  });

  it('notes a Repository that is not ready but has a commit', async () => {
    const { handler } = scripted({
      snapshot: { state: 'fetching', commit: COMMIT },
      tree: listed([file('a')]),
    });

    const result = await handler.execute();

    expect(result.commit).toBe(COMMIT);
    expect(result.repository?.note).toContain('last fetched commit');
  });

  it.each([
    ['repository_not_ready', 'no Clone'],
    ['unsupported_platform', 'Linux'],
    ['failed', 'could not be read'],
  ] as const)('explains a tree that could not be read (%s)', async (status, words) => {
    const { handler } = scripted({ tree: { status } });

    const result = await handler.execute();

    expect(result).toMatchObject({ commit: null, entries: [], truncated: false });
    expect(result.repository?.note).toContain(words);
  });
});
