import { beforeEach, describe, expect, it } from 'vitest';
import {
  DraftBaseMissingError,
  DraftBaseUnreadableError,
  DraftFileNotFoundError,
  DraftPathNotWritableError,
} from '../../../../domain/errors/agent-draft-errors.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { BASE_COMMIT, FakeDefinitionsFiles } from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftBaseReader } from '../../../agent-draft-base.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import { DeleteAgentDraftFileHandler } from '../handler.js';

const NOW = new Date('2026-11-25T10:00:00.000Z');

describe('DeleteAgentDraftFileHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: DeleteAgentDraftFileHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles({
      'README.md': 'top\n',
      'link.md': { symlink: 'README.md' },
    });
    repository = new InMemoryAgentDraftRepository();
    handler = new DeleteAgentDraftFileHandler(
      repository,
      new AgentDraftBaseReader(definitions),
      new AgentDraftReader(definitions, repository),
    );
  });

  async function seedAdded(path: string) {
    const draft = await repository.find();
    draft.put({
      currentCommit: BASE_COMMIT,
      baseEntries: [{ path: 'README.md', kind: 'file' }],
      now: NOW,
      path,
      size: 1,
    });
    await repository.save(draft, new Map([[path, new Uint8Array([120])]]));
  }

  it('marks a base file deleted, which takes the base commit', async () => {
    const view = await handler.execute({ path: 'README.md' });

    expect(view).toMatchObject({
      baseCommit: BASE_COMMIT,
      version: 1,
      files: [{ path: 'README.md', change: 'deleted', size: 0, movedFrom: null }],
    });
    expect(repository.contents.has('README.md')).toBe(false);
  });

  it('drops an added file with its bytes, and the Draft is empty again', async () => {
    await seedAdded('docs/new.md');

    const view = await handler.execute({ path: 'docs/new.md' });

    expect(view).toMatchObject({ baseCommit: null, files: [], version: 2 });
    expect(repository.contents.has('docs/new.md')).toBe(false);
  });

  it('deletes a modified file in one call, dropping its content change', async () => {
    const draft = await repository.find();
    draft.put({
      currentCommit: BASE_COMMIT,
      baseEntries: [{ path: 'README.md', kind: 'file' }],
      now: NOW,
      path: 'README.md',
      size: 1,
    });
    await repository.save(draft, new Map([['README.md', new Uint8Array([120])]]));

    const view = await handler.execute({ path: 'README.md' });

    expect(view.files).toEqual([
      { path: 'README.md', change: 'deleted', size: 0, movedFrom: null },
    ]);
    expect(view.version).toBe(2);
    expect(repository.contents.has('README.md')).toBe(false);
  });

  it('refuses a file the Draft already deletes', async () => {
    await handler.execute({ path: 'README.md' });

    await expect(handler.execute({ path: 'README.md' })).rejects.toThrow(DraftFileNotFoundError);
  });

  it('tries again when another write got in first, and gives up after three attempts', async () => {
    repository.conflicts = 2;
    await expect(handler.execute({ path: 'README.md' })).resolves.toMatchObject({
      files: [{ path: 'README.md', change: 'deleted' }],
    });

    repository.conflicts = 3;
    await expect(handler.execute({ path: 'link.md' })).rejects.toThrow(DraftPathNotWritableError);
    await expect(handler.execute({ path: 'docs.md' })).rejects.toThrow(DraftFileNotFoundError);
  });

  it('says so when the commit the Draft began from is gone', async () => {
    await handler.execute({ path: 'README.md' });
    definitions.commits.delete(BASE_COMMIT);

    await expect(handler.execute({ path: 'README.md' })).rejects.toThrow(DraftBaseMissingError);
  });

  it('refuses a path nowhere and a link, and saves nothing', async () => {
    await expect(handler.execute({ path: 'nothing.md' })).rejects.toThrow(DraftFileNotFoundError);
    await expect(handler.execute({ path: 'link.md' })).rejects.toThrow(DraftPathNotWritableError);
    expect(repository.saves).toBe(0);
  });

  it('refuses when the tree cannot be read', async () => {
    definitions.unavailable = 'failed';

    await expect(handler.execute({ path: 'README.md' })).rejects.toThrow(DraftBaseUnreadableError);
  });
});
