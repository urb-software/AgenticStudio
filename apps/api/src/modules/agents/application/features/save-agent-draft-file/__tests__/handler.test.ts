import { beforeEach, describe, expect, it } from 'vitest';
import {
  DraftBaseMissingError,
  DraftBaseUnreadableError,
  DraftChangedConcurrentlyError,
  DraftNoBaseError,
  DraftPathNotWritableError,
} from '../../../../domain/errors/agent-draft-errors.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { DraftFileTooLargeError } from '../../../../domain/value-objects/agent-draft-file-size.js';
import { InvalidAgentDraftPathError } from '../../../../domain/value-objects/agent-draft-path.js';
import {
  BASE_COMMIT,
  FakeDefinitionsFiles,
  NEXT_COMMIT,
} from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftBaseReader } from '../../../agent-draft-base.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import { SaveAgentDraftFileHandler } from '../handler.js';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('SaveAgentDraftFileHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: SaveAgentDraftFileHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles({
      'README.md': 'top\n',
      'link.md': { symlink: 'README.md' },
    });
    repository = new InMemoryAgentDraftRepository();
    handler = new SaveAgentDraftFileHandler(
      repository,
      new AgentDraftBaseReader(definitions),
      new AgentDraftReader(definitions, repository),
    );
  });

  it('stores the bytes, takes the current commit as base and answers the new Draft', async () => {
    const view = await handler.execute({ path: 'docs/new.md', content: bytes('hello') });

    expect(view).toMatchObject({
      baseCommit: BASE_COMMIT,
      currentCommit: BASE_COMMIT,
      version: 1,
      files: [{ path: 'docs/new.md', change: 'added', size: 5, movedFrom: null }],
    });
    expect(repository.contents.get('docs/new.md')).toEqual(bytes('hello'));
    expect(repository.stored.baseCommit).toBe(BASE_COMMIT);
  });

  it('marks a base file modified and keeps the base when the Repository moves on', async () => {
    await handler.execute({ path: 'README.md', content: bytes('edited') });
    definitions.commit(NEXT_COMMIT, { 'README.md': 'upstream\n' });
    definitions.head = NEXT_COMMIT;

    const view = await handler.execute({ path: 'docs/new.md', content: bytes('x') });

    expect(view.baseCommit).toBe(BASE_COMMIT);
    expect(view.currentCommit).toBe(NEXT_COMMIT);
    expect(view.version).toBe(2);
    expect(view.files.map((file) => [file.path, file.change])).toEqual([
      ['README.md', 'modified'],
      ['docs/new.md', 'added'],
    ]);
    expect(view.movedUpstream).toEqual(['README.md']);
  });

  it('keeps the last write of a path, with its bytes', async () => {
    await handler.execute({ path: 'docs/new.md', content: bytes('first') });

    const view = await handler.execute({ path: 'docs/new.md', content: bytes('second!') });

    expect(view.files).toEqual([
      { path: 'docs/new.md', change: 'added', size: 7, movedFrom: null },
    ]);
    expect(repository.contents.get('docs/new.md')).toEqual(bytes('second!'));
    expect(view.version).toBe(2);
  });

  it('tries again when another write got in first, and the change still lands', async () => {
    repository.conflicts = 2;

    const view = await handler.execute({ path: 'docs/new.md', content: bytes('hello') });

    expect(view.files.map((file) => file.path)).toEqual(['docs/new.md']);
    expect(repository.saves).toBe(1);
    // Two other writes came in first, so this one is the third: the version only rises.
    expect(view.version).toBe(3);
  });

  it('gives up with a conflict after three attempts', async () => {
    repository.conflicts = 3;

    await expect(handler.execute({ path: 'docs/new.md', content: bytes('x') })).rejects.toThrow(
      DraftChangedConcurrentlyError,
    );
    expect(repository.saves).toBe(0);
  });

  it('says so when the commit the Draft began from is gone, and the Draft can be discarded', async () => {
    await handler.execute({ path: 'README.md', content: bytes('edited') });
    definitions.commits.delete(BASE_COMMIT);

    await expect(handler.execute({ path: 'a.md', content: bytes('x') })).rejects.toThrow(
      DraftBaseMissingError,
    );
  });

  it('stores nothing when the entity refuses', async () => {
    await expect(
      handler.execute({ path: 'big.bin', content: new Uint8Array(1024 * 1024 + 1) }),
    ).rejects.toThrow(DraftFileTooLargeError);
    await expect(handler.execute({ path: 'link.md', content: bytes('x') })).rejects.toThrow(
      DraftPathNotWritableError,
    );
    await expect(handler.execute({ path: '../escape', content: bytes('x') })).rejects.toThrow(
      InvalidAgentDraftPathError,
    );

    expect(repository.saves).toBe(0);
  });

  it('refuses without a commit, and when the tree cannot be read', async () => {
    definitions.head = null;
    await expect(handler.execute({ path: 'a.md', content: bytes('x') })).rejects.toThrow(
      DraftNoBaseError,
    );
    definitions.head = BASE_COMMIT;
    definitions.unavailable = 'unsupported_platform';
    await expect(handler.execute({ path: 'a.md', content: bytes('x') })).rejects.toThrow(
      DraftBaseUnreadableError,
    );
    definitions.unavailable = null;
    definitions.truncated = true;
    await expect(handler.execute({ path: 'a.md', content: bytes('x') })).rejects.toThrow(
      DraftBaseUnreadableError,
    );
    expect(repository.saves).toBe(0);
  });
});
