import { beforeEach, describe, expect, it } from 'vitest';
import {
  DraftBaseUnreadableError,
  DraftFileNotFoundError,
  DraftMoveUnsupportedError,
  DraftPathNotWritableError,
  DraftPathTakenError,
} from '../../../../domain/errors/agent-draft-errors.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { BASE_COMMIT, FakeDefinitionsFiles } from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftBaseReader } from '../../../agent-draft-base.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import { MoveAgentDraftFileHandler } from '../handler.js';

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe('MoveAgentDraftFileHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: MoveAgentDraftFileHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles({
      'README.md': 'top\n',
      'docs/a.md': 'a\n',
      'blob.bin': Buffer.from([0, 1, 2]),
      'link.md': { symlink: 'README.md' },
    });
    repository = new InMemoryAgentDraftRepository();
    handler = new MoveAgentDraftFileHandler(
      repository,
      definitions,
      new AgentDraftBaseReader(definitions),
      new AgentDraftReader(definitions, repository),
    );
  });

  it('moves a base file: the old path is deleted and the new one holds its text', async () => {
    const view = await handler.execute({ from: 'README.md', to: 'docs/README.md' });

    expect(view).toMatchObject({ baseCommit: BASE_COMMIT, version: 1 });
    expect(view.files).toEqual([
      { path: 'README.md', change: 'deleted', size: 0, movedFrom: null },
      { path: 'docs/README.md', change: 'added', size: 4, movedFrom: 'README.md' },
    ]);
    expect(text(repository.contents.get('docs/README.md'))).toBe('top\n');
    expect(repository.contents.has('README.md')).toBe(false);
  });

  it('moves with the Draft content when the Draft holds the file, and drops a Draft-only source', async () => {
    const draft = await repository.find();
    draft.put({
      currentCommit: BASE_COMMIT,
      baseEntries: [],
      now: new Date(),
      path: 'new.md',
      size: 6,
    });
    await repository.save(draft, new Map([['new.md', new TextEncoder().encode('drafty')]]));

    const view = await handler.execute({ from: 'new.md', to: 'other.md' });

    expect(view.files).toEqual([{ path: 'other.md', change: 'added', size: 6, movedFrom: null }]);
    expect(text(repository.contents.get('other.md'))).toBe('drafty');
    expect(repository.contents.has('new.md')).toBe(false);
  });

  it('refuses a target that exists, and saves nothing', async () => {
    await expect(handler.execute({ from: 'README.md', to: 'docs/a.md' })).rejects.toThrow(
      DraftPathTakenError,
    );
    expect(repository.saves).toBe(0);
  });

  it('refuses a source that is nowhere, or a link', async () => {
    await expect(handler.execute({ from: 'nothing.md', to: 'x.md' })).rejects.toThrow(
      DraftFileNotFoundError,
    );
    await expect(handler.execute({ from: 'link.md', to: 'x.md' })).rejects.toThrow(
      DraftPathNotWritableError,
    );
    expect(repository.saves).toBe(0);
  });

  it('carries the stored bytes of a binary base file unchanged', async () => {
    const view = await handler.execute({ from: 'blob.bin', to: 'assets/blob.bin' });

    expect(view.files).toContainEqual({
      path: 'assets/blob.bin',
      change: 'added',
      size: 3,
      movedFrom: 'blob.bin',
    });
    expect(repository.contents.get('assets/blob.bin')).toEqual(new Uint8Array([0, 1, 2]));
  });

  it('cannot carry a base file over the file limit', async () => {
    definitions.commit(BASE_COMMIT, { 'huge.txt': Buffer.alloc(1024 * 1024 + 1, 97) });

    await expect(handler.execute({ from: 'huge.txt', to: 'x.txt' })).rejects.toThrow(
      DraftMoveUnsupportedError,
    );
    expect(repository.saves).toBe(0);
  });

  it('refuses a source that the Draft deleted', async () => {
    await handler.execute({ from: 'README.md', to: 'moved.md' });

    await expect(handler.execute({ from: 'README.md', to: 'again.md' })).rejects.toThrow(
      DraftFileNotFoundError,
    );
  });

  it('refuses when the tree or the file cannot be read', async () => {
    definitions.unavailable = 'unsupported_platform';

    await expect(handler.execute({ from: 'README.md', to: 'x.md' })).rejects.toThrow(
      DraftBaseUnreadableError,
    );
  });
});
