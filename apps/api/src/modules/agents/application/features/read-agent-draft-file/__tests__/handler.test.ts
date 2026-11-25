import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentDraft } from '../../../../domain/entities/agent-draft.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import {
  BASE_COMMIT,
  FakeDefinitionsFiles,
  NEXT_COMMIT,
} from '../../../__tests__/fake-definitions-files.js';
import { ReadAgentDraftFileHandler } from '../handler.js';

const NOW = new Date('2026-11-25T10:00:00.000Z');
const BASE_FILES = { 'README.md': 'base text\n', 'a.bin': Buffer.from([0, 1, 2]) };
const facts = {
  currentCommit: BASE_COMMIT,
  baseEntries: [
    { path: 'README.md', kind: 'file' as const },
    { path: 'a.bin', kind: 'file' as const },
  ],
  now: NOW,
};

describe('ReadAgentDraftFileHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: ReadAgentDraftFileHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles(BASE_FILES);
    repository = new InMemoryAgentDraftRepository();
    handler = new ReadAgentDraftFileHandler(repository, definitions);
  });

  async function draftWith(
    step: (draft: AgentDraft) => void,
    contents: Record<string, Buffer> = {},
  ) {
    const draft = await repository.find();
    step(draft);
    await repository.save(draft, new Map(Object.entries(contents)));
  }

  it('reads the Draft content of a modified file, with the base commit', async () => {
    await draftWith((draft) => draft.put({ ...facts, path: 'README.md', size: 3 }), {
      'README.md': Buffer.from('new'),
    });

    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({
      status: 'read',
      commit: BASE_COMMIT,
      path: 'README.md',
      content: { kind: 'text', content: 'new' },
    });
  });

  it('reads an added file, and tells binary content by a NUL byte or by bad UTF-8', async () => {
    await draftWith(
      (draft) => {
        draft.put({ ...facts, path: 'new.txt', size: 5 });
        draft.put({ ...facts, path: 'nul.dat', size: 3 });
        draft.put({ ...facts, path: 'latin.txt', size: 2 });
      },
      {
        'new.txt': Buffer.from('café'),
        'nul.dat': Buffer.from([0x61, 0x00, 0x62]),
        'latin.txt': Buffer.from([0xe9, 0x61]),
      },
    );

    await expect(handler.execute({ path: 'new.txt' })).resolves.toMatchObject({
      content: { kind: 'text', content: 'café' },
    });
    await expect(handler.execute({ path: 'nul.dat' })).resolves.toMatchObject({
      content: { kind: 'binary', size: 3 },
    });
    await expect(handler.execute({ path: 'latin.txt' })).resolves.toMatchObject({
      content: { kind: 'binary', size: 2 },
    });
  });

  it('keeps an empty Draft file as text', async () => {
    await draftWith((draft) => draft.put({ ...facts, path: 'empty.txt', size: 0 }), {
      'empty.txt': Buffer.alloc(0),
    });

    await expect(handler.execute({ path: 'empty.txt' })).resolves.toMatchObject({
      content: { kind: 'text', content: '' },
    });
  });

  it('is not found for a file the Draft deletes, though the base holds it', async () => {
    await draftWith((draft) => draft.delete({ ...facts, path: 'README.md' }));

    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({ status: 'not_found' });
  });

  it('falls through to the base commit for a file the Draft does not change', async () => {
    await draftWith((draft) => draft.put({ ...facts, path: 'new.txt', size: 1 }), {
      'new.txt': Buffer.from('x'),
    });
    // The Repository moved on, but the Draft still reads its own base.
    definitions.commit(NEXT_COMMIT, { 'README.md': 'upstream\n' });
    definitions.head = NEXT_COMMIT;

    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({
      status: 'read',
      commit: BASE_COMMIT,
      path: 'README.md',
      content: { kind: 'text', content: 'base text\n' },
    });
    await expect(handler.execute({ path: 'a.bin' })).resolves.toMatchObject({
      content: { kind: 'binary', size: 3 },
    });
  });

  it('reads the current commit while the Draft is empty', async () => {
    await expect(handler.execute({ path: 'README.md' })).resolves.toMatchObject({
      commit: BASE_COMMIT,
      content: { kind: 'text', content: 'base text\n' },
    });
  });

  it('is not found for a path that is nowhere, and without any commit', async () => {
    await expect(handler.execute({ path: 'nothing' })).resolves.toEqual({ status: 'not_found' });
    definitions.head = null;
    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({ status: 'not_found' });
  });

  it('maps a Clone that cannot be read', async () => {
    definitions.unavailable = 'unsupported_platform';
    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({
      status: 'unreadable',
    });
    definitions.unavailable = 'commit_missing';
    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({
      status: 'commit_missing',
    });
    definitions.unavailable = 'repository_not_ready';
    await expect(handler.execute({ path: 'README.md' })).resolves.toEqual({ status: 'not_found' });
  });
});
