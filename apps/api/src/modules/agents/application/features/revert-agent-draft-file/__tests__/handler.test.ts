import { beforeEach, describe, expect, it } from 'vitest';
import {
  DraftChangedConcurrentlyError,
  DraftFileNotFoundError,
} from '../../../../domain/errors/agent-draft-errors.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { InvalidAgentDraftPathError } from '../../../../domain/value-objects/agent-draft-path.js';
import { BASE_COMMIT, FakeDefinitionsFiles } from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import { RevertAgentDraftFileHandler } from '../handler.js';

const facts = {
  currentCommit: BASE_COMMIT,
  baseEntries: [
    { path: 'README.md', kind: 'file' as const },
    { path: 'docs/a.md', kind: 'file' as const },
  ],
  now: new Date('2026-11-25T10:00:00.000Z'),
};

describe('RevertAgentDraftFileHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: RevertAgentDraftFileHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles({ 'README.md': 'top\n', 'docs/a.md': 'a\n' });
    repository = new InMemoryAgentDraftRepository();
    handler = new RevertAgentDraftFileHandler(
      repository,
      new AgentDraftReader(definitions, repository),
    );
  });

  async function seed(step: (draft: Awaited<ReturnType<typeof repository.find>>) => void) {
    const draft = await repository.find();
    step(draft);
    await repository.save(
      draft,
      new Map([
        ['README.md', new Uint8Array([1])],
        ['new.md', new Uint8Array([2])],
        ['docs/b.md', new Uint8Array([3])],
      ]),
    );
  }

  it('drops the change at a path and its bytes, and answers the new Draft', async () => {
    await seed((draft) => {
      draft.put({ ...facts, path: 'README.md', size: 1 });
      draft.put({ ...facts, path: 'new.md', size: 1 });
    });

    const view = await handler.execute({ path: 'README.md' });

    expect(view.files.map((file) => file.path)).toEqual(['new.md']);
    expect(view.version).toBe(3);
    expect(repository.contents.has('README.md')).toBe(false);
  });

  it('brings back a deleted file, and empties the Draft with its last change', async () => {
    await seed((draft) => draft.delete({ ...facts, path: 'README.md' }));

    const view = await handler.execute({ path: 'README.md' });

    expect(view).toMatchObject({ files: [], baseCommit: null });
  });

  it('removes the new path of a moved file and restores the original', async () => {
    await seed((draft) => draft.move({ ...facts, from: 'docs/a.md', to: 'docs/b.md', size: 1 }));

    const view = await handler.execute({ path: 'docs/b.md' });

    expect(view.files).toEqual([]);
    expect(repository.contents.has('docs/b.md')).toBe(false);
  });

  it('reads nothing from the Repository', async () => {
    await seed((draft) => draft.put({ ...facts, path: 'new.md', size: 1 }));
    definitions.unavailable = 'unsupported_platform';

    await expect(handler.execute({ path: 'new.md' })).resolves.toMatchObject({ files: [] });
  });

  it('refuses a path the Draft does not change and a bad path', async () => {
    await expect(handler.execute({ path: 'README.md' })).rejects.toThrow(DraftFileNotFoundError);
    await expect(handler.execute({ path: '../x' })).rejects.toThrow(InvalidAgentDraftPathError);
    expect(repository.saves).toBe(0);
  });

  it('tries again when another write got in first, and gives up after three attempts', async () => {
    await seed((draft) => draft.put({ ...facts, path: 'new.md', size: 1 }));
    repository.conflicts = 2;
    await expect(handler.execute({ path: 'new.md' })).resolves.toMatchObject({ files: [] });

    await seed((draft) => draft.put({ ...facts, path: 'new.md', size: 1 }));
    repository.conflicts = 3;
    await expect(handler.execute({ path: 'new.md' })).rejects.toThrow(
      DraftChangedConcurrentlyError,
    );
  });
});
