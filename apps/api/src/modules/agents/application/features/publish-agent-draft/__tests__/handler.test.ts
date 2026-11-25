import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsPublish,
  DefinitionsPublishInput,
} from '../../../../../projects/contracts/index.js';
import { AgentDraft } from '../../../../domain/entities/agent-draft.js';
import {
  DraftBaseMissingError,
  DraftBaseUnreadableError,
  DraftChangedConcurrentlyError,
} from '../../../../domain/errors/agent-draft-errors.js';
import {
  NothingToPublishError,
  PublishFailedError,
  PublishNotConfiguredError,
  PublishPathOutsideAgentsError,
  PublishProblemsError,
  PublishRunningError,
  RepositoryMovedError,
  WriteRefusedError,
} from '../../../../domain/errors/agent-publish-errors.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { InvalidPublishMessageError } from '../../../../domain/value-objects/publish-message.js';
import {
  BASE_COMMIT,
  FakeDefinitionsFiles,
  NEXT_COMMIT,
  type FakeCommitFile,
} from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftBaseReader } from '../../../agent-draft-base.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import type { PublishLock } from '../../../ports/publish-lock.js';
import { PublishAgentDraftHandler } from '../handler.js';

const NOW = new Date('2026-11-25T10:00:00.000Z');
const PUBLISHED = 'c'.repeat(40);
const IDENTITY = { name: 'Studio Publisher', email: 'studio@example.test' };

const agentFile = (name: string) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: codex\n---\nWork as ${name}.\n`;

const BASE_FILES: Record<string, FakeCommitFile> = {
  'README.md': 'top\n',
  'agents/reviewer/AGENT.md': agentFile('reviewer'),
  'agents/reviewer/notes.txt': 'notes\n',
  'agents/reviewer/run.sh': { executable: '#!/bin/sh\n' },
  'agents/broken/AGENT.md': 'no front matter at all\n',
  'docs/a.md': 'a\n',
  'agents/reviewer/old.txt': 'old\n',
};

/** An in-process lock that is taken without waiting, like the database's. */
class FakeLock implements PublishLock {
  held = false;
  takes = 0;

  async runExclusive<T>(work: () => Promise<T>) {
    if (this.held) return { ran: false as const };
    this.held = true;
    this.takes += 1;
    try {
      return { ran: true as const, value: await work() };
    } finally {
      this.held = false;
    }
  }
}

describe('PublishAgentDraftHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let lock: FakeLock;
  let publisher: { publish: ReturnType<typeof vi.fn<DefinitionsPublish['publish']>> };
  let identity: { name: string; email: string } | null;
  let handler: PublishAgentDraftHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles(BASE_FILES);
    repository = new InMemoryAgentDraftRepository();
    lock = new FakeLock();
    publisher = {
      publish: vi.fn<DefinitionsPublish['publish']>(() =>
        Promise.resolve({ status: 'published', commit: PUBLISHED }),
      ),
    };
    identity = IDENTITY;
    handler = new PublishAgentDraftHandler(
      repository,
      new AgentDraftBaseReader(definitions),
      new AgentDraftReader(definitions, repository),
      definitions,
      publisher,
      lock,
      { get: () => identity },
    );
  });

  interface DraftFacts {
    currentCommit: string;
    baseEntries: { path: string; kind: 'file' }[];
    now: Date;
  }
  const entries = () => Object.keys(BASE_FILES).map((path) => ({ path, kind: 'file' as const }));

  /** Writes to the Draft as the write features do, at the base commit. */
  async function draftWith(
    steps: (draft: AgentDraft, facts: DraftFacts) => void,
    contents: Record<string, string> = {},
  ) {
    const draft = await repository.find();
    steps(draft, facts());
    await repository.save(
      draft,
      new Map(Object.entries(contents).map(([path, text]) => [path, Buffer.from(text)])),
    );
    return draft.version;
  }
  const facts = () => ({ currentCommit: BASE_COMMIT, baseEntries: entries(), now: NOW });

  async function realisticDraft() {
    return draftWith(
      (draft, f) => {
        draft.put({ ...f, path: 'agents/new/AGENT.md', size: agentFile('new').length });
        draft.put({ ...f, path: 'agents/reviewer/notes.txt', size: 6 });
        draft.put({ ...f, path: 'agents/reviewer/run.sh', size: 9 });
        draft.delete({ ...f, path: 'agents/reviewer/old.txt' });
      },
      {
        'agents/new/AGENT.md': agentFile('new'),
        'agents/reviewer/notes.txt': 'notes2',
        'agents/reviewer/run.sh': '#!/bin/sh\n',
      },
    );
  }

  const request = (version: number, overrides: Record<string, unknown> = {}) => ({
    message: 'Add the new agent',
    baseCommit: BASE_COMMIT,
    version,
    ...overrides,
  });

  it('publishes every change on top of the base with the settings identity, then discards the Draft', async () => {
    const version = await realisticDraft();

    await expect(handler.execute(request(version))).resolves.toEqual({ commit: PUBLISHED });

    expect(publisher.publish).toHaveBeenCalledTimes(1);
    const sent = publisher.publish.mock.calls[0]![0] as DefinitionsPublishInput;
    expect(sent.baseCommit).toBe(BASE_COMMIT);
    expect(sent.message).toBe('Add the new agent');
    expect(sent.identity).toEqual(IDENTITY);
    expect(sent.changes.map(({ path, executable }) => [path, executable])).toEqual([
      ['agents/new/AGENT.md', false],
      // A modified file keeps the mode the base has; an added one is a plain file.
      ['agents/reviewer/notes.txt', false],
      ['agents/reviewer/old.txt', false],
      ['agents/reviewer/run.sh', true],
    ]);
    const byPath = new Map(sent.changes.map((change) => [change.path, change.content]));
    expect(Buffer.from(byPath.get('agents/new/AGENT.md')!).toString()).toBe(agentFile('new'));
    expect(Buffer.from(byPath.get('agents/reviewer/notes.txt')!).toString()).toBe('notes2');
    expect(byPath.get('agents/reviewer/old.txt')).toBeNull();
    // The Draft is gone: no file, no base, no stored bytes.
    expect(repository.stored).toMatchObject({ baseCommit: null, files: [] });
    expect(repository.contents.size).toBe(0);
    expect(lock.held).toBe(false);
  });

  it('takes the identity and the message from nowhere but the settings and the request', async () => {
    const version = await realisticDraft();

    await handler.execute(request(version, { identity: { name: 'Mallory', email: 'm@x.test' } }));

    expect((publisher.publish.mock.calls[0]![0] as DefinitionsPublishInput).identity).toEqual(
      IDENTITY,
    );
  });

  it('answers publish_not_configured without a settings identity, before it locks or reads anything', async () => {
    const version = await realisticDraft();
    identity = null;

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(
      PublishNotConfiguredError,
    );

    expect(lock.takes).toBe(0);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.stored.files).toHaveLength(4);
  });

  it('refuses a message that is not a message, before it locks', async () => {
    const version = await realisticDraft();

    await expect(handler.execute(request(version, { message: '  \n' }))).rejects.toBeInstanceOf(
      InvalidPublishMessageError,
    );

    expect(lock.takes).toBe(0);
  });

  it('answers a Draft that changed since the page read it, publishing nothing', async () => {
    const version = await realisticDraft();

    await expect(handler.execute(request(version - 1))).rejects.toBeInstanceOf(
      DraftChangedConcurrentlyError,
    );
    await expect(
      handler.execute(request(version, { baseCommit: NEXT_COMMIT })),
    ).rejects.toBeInstanceOf(DraftChangedConcurrentlyError);

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.stored.files).toHaveLength(4);
  });

  it('answers nothing to publish for an empty Draft', async () => {
    await expect(handler.execute(request(0))).rejects.toBeInstanceOf(NothingToPublishError);

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('answers that the Repository moved when it holds another commit than the Draft began from', async () => {
    const version = await realisticDraft();
    definitions.head = NEXT_COMMIT;
    definitions.commit(NEXT_COMMIT, { ...BASE_FILES, 'later.md': 'later\n' });

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(RepositoryMovedError);

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.stored.files).toHaveLength(4);
  });

  it('refuses while any problem of the Draft stands, naming each, and publishes nothing', async () => {
    const version = await draftWith(
      (draft, f) => {
        draft.put({ ...f, path: 'agents/broken/AGENT.md', size: 4 });
        draft.put({ ...f, path: 'agents/new/AGENT.md', size: agentFile('new').length });
      },
      { 'agents/broken/AGENT.md': 'oops', 'agents/new/AGENT.md': agentFile('new') },
    );

    const error = await handler.execute(request(version)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PublishProblemsError);
    expect((error as PublishProblemsError).problems.map((problem) => problem.agent)).toEqual([
      'broken',
    ]);
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.stored.files).toHaveLength(2);
  });

  it('refuses a Draft it cannot judge: a Clone it cannot read, or a base commit that is gone', async () => {
    const version = await realisticDraft();
    definitions.unavailable = 'failed';

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(
      DraftBaseUnreadableError,
    );
    definitions.unavailable = null;
    // The commit the Draft began from is gone from the Clone: it can only be discarded.
    definitions.commits.delete(BASE_COMMIT);
    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(DraftBaseMissingError);
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('answers publish_running to a second publish while one holds the lock', async () => {
    const version = await realisticDraft();
    lock.held = true;

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(PublishRunningError);

    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.stored.files).toHaveLength(4);
  });

  it('lets one of two publishes at once win', async () => {
    const version = await realisticDraft();
    let release: () => void = () => undefined;
    publisher.publish.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'published', commit: PUBLISHED });
        }),
    );

    const first = handler.execute(request(version));
    await vi.waitFor(() => expect(publisher.publish).toHaveBeenCalled());
    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(PublishRunningError);
    release();

    await expect(first).resolves.toEqual({ commit: PUBLISHED });
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['repository_moved', RepositoryMovedError],
    ['write_refused', WriteRefusedError],
    ['nothing_to_publish', NothingToPublishError],
    ['repository_not_ready', PublishFailedError],
    ['unsupported_platform', PublishFailedError],
    ['failed', PublishFailedError],
  ] as const)('maps %s to its refusal and keeps the Draft and its bytes', async (status, error) => {
    const version = await realisticDraft();
    publisher.publish.mockResolvedValueOnce({ status });

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(error);

    expect(repository.stored.files).toHaveLength(4);
    expect(repository.stored.version).toBe(version);
    expect(repository.contents.size).toBe(3);
    expect(lock.held).toBe(false);
  });

  it('releases the lock when the publish throws unexpectedly', async () => {
    const version = await realisticDraft();
    publisher.publish.mockRejectedValueOnce(new Error('boom'));

    await expect(handler.execute(request(version))).rejects.toThrow('boom');

    expect(lock.held).toBe(false);
    expect(repository.stored.files).toHaveLength(4);
  });

  it('keeps a newer Draft that was saved while the push ran, discarding only the published version', async () => {
    const version = await realisticDraft();
    publisher.publish.mockImplementationOnce(async () => {
      const draft = await repository.find();
      draft.put({ ...facts(), path: 'agents/new/extra.md', size: 1 });
      await repository.save(draft, new Map([['agents/new/extra.md', Buffer.from('x')]]));
      return { status: 'published', commit: PUBLISHED };
    });

    await expect(handler.execute(request(version))).resolves.toEqual({ commit: PUBLISHED });

    expect(repository.stored.version).toBe(version + 1);
    expect(repository.stored.files.map((file) => file.path)).toContain('agents/new/extra.md');
    expect(repository.contents.has('agents/new/extra.md')).toBe(true);
  });

  it('pushes only the bytes it judged: a save between the judgement and the read is a conflict', async () => {
    const version = await realisticDraft();
    const original = repository.findContents.bind(repository);
    let calls = 0;
    repository.findContents = async (paths) => {
      calls += 1;
      // The second read is the one that fetches the bytes to push.
      if (calls === 2) {
        const draft = await repository.find();
        draft.put({ ...facts(), path: 'agents/new/AGENT.md', size: 5 });
        await repository.save(draft, new Map([['agents/new/AGENT.md', Buffer.from('hooks')]]));
      }
      return original(paths);
    };

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(
      DraftChangedConcurrentlyError,
    );

    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('answers a conflict, not a failure, for a file reverted between the judgement and the read', async () => {
    const version = await realisticDraft();
    const original = repository.findContents.bind(repository);
    let calls = 0;
    repository.findContents = async (paths) => {
      calls += 1;
      if (calls === 2) {
        const draft = await repository.find();
        draft.revert({ ...facts(), path: 'agents/reviewer/notes.txt' });
        await repository.save(draft, new Map());
      }
      return original(paths);
    };

    await expect(handler.execute(request(version))).rejects.toBeInstanceOf(
      DraftChangedConcurrentlyError,
    );
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('refuses a Draft that was not judged because the entry files could not be read', async () => {
    const version = await realisticDraft();
    definitions.readFilesFails = true;

    const error = await handler.execute(request(version)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PublishFailedError);
    expect((error as PublishFailedError).reason).toBe('repository_not_ready');
    expect(publisher.publish).not.toHaveBeenCalled();
    expect(repository.stored.files).toHaveLength(4);
  });

  it('refuses any changed path outside agents/, listing them, and publishes nothing', async () => {
    const version = await draftWith(
      (draft, f) => {
        draft.put({ ...f, path: 'agents/new/AGENT.md', size: agentFile('new').length });
        draft.put({ ...f, path: '.github/workflows/ci.yml', size: 1 });
        draft.delete({ ...f, path: 'docs/a.md' });
      },
      { 'agents/new/AGENT.md': agentFile('new'), '.github/workflows/ci.yml': 'x' },
    );

    const error = await handler.execute(request(version)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PublishPathOutsideAgentsError);
    expect((error as PublishPathOutsideAgentsError).paths).toEqual([
      '.github/workflows/ci.yml',
      'docs/a.md',
    ]);
    expect(publisher.publish).not.toHaveBeenCalled();
  });
});
