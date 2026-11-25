import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectKind, ProjectKinds } from '../../../../../projects/contracts/index.js';
import { DraftChangedConcurrentlyError } from '../../../../domain/errors/agent-draft-errors.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { BASE_COMMIT } from '../../../__tests__/fake-definitions-files.js';
import { DiscardAgentDraftForDisconnectHandler } from '../handler.js';

const DEFINITIONS = '4a3c9d2f-5e6b-4c7d-8e8f-9a0b1c2d3e4f';
const CODE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('DiscardAgentDraftForDisconnectHandler', () => {
  let repository: InMemoryAgentDraftRepository;
  let handler: DiscardAgentDraftForDisconnectHandler;

  beforeEach(async () => {
    repository = new InMemoryAgentDraftRepository();
    const kinds: ProjectKinds = {
      kindOf: (id) =>
        Promise.resolve<ProjectKind | null>(
          id === DEFINITIONS ? 'definitions' : id === CODE ? 'code' : null,
        ),
      definitionsProjectId: () => Promise.resolve(DEFINITIONS),
    };
    handler = new DiscardAgentDraftForDisconnectHandler(kinds, repository);
    const draft = await repository.find();
    draft.put({
      currentCommit: BASE_COMMIT,
      baseEntries: [],
      now: new Date(),
      path: 'a.md',
      size: 1,
    });
    await repository.save(draft, new Map([['a.md', new Uint8Array([1])]]));
  });

  it('discards the Draft when the definitions Repository is disconnected', async () => {
    await expect(handler.execute({ projectId: DEFINITIONS })).resolves.toBe('done');

    expect(repository.stored).toMatchObject({ files: [], baseCommit: null });
    expect(repository.contents.size).toBe(0);
  });

  it('is idempotent: an empty Draft is left as it is', async () => {
    await handler.execute({ projectId: DEFINITIONS });
    const version = repository.stored.version;

    await expect(handler.execute({ projectId: DEFINITIONS })).resolves.toBe('done');

    expect(repository.stored.version).toBe(version);
  });

  it('leaves the Draft alone for any other Project, and for an unknown one', async () => {
    await expect(handler.execute({ projectId: CODE })).resolves.toBe('done');
    await expect(handler.execute({ projectId: 'nope' })).resolves.toBe('done');

    expect(repository.stored.files).toHaveLength(1);
  });

  it('retries after a lost race, and fails the step when every attempt lost', async () => {
    repository.conflicts = 2;
    await expect(handler.execute({ projectId: DEFINITIONS })).resolves.toBe('done');

    const draft = await repository.find();
    draft.put({
      currentCommit: BASE_COMMIT,
      baseEntries: [],
      now: new Date(),
      path: 'b.md',
      size: 1,
    });
    await repository.save(draft, new Map([['b.md', new Uint8Array([1])]]));
    repository.conflicts = 3;
    await expect(handler.execute({ projectId: DEFINITIONS })).rejects.toThrow(
      DraftChangedConcurrentlyError,
    );
  });
});
