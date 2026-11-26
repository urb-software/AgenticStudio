import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { BASE_COMMIT, FakeDefinitionsFiles } from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import { DiscardAgentDraftHandler } from '../handler.js';

describe('DiscardAgentDraftHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: DiscardAgentDraftHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles({ 'README.md': 'top\n' });
    repository = new InMemoryAgentDraftRepository();
    handler = new DiscardAgentDraftHandler(
      repository,
      new AgentDraftReader(definitions, repository),
    );
  });

  it('drops every change, the bytes and the base, and raises the version', async () => {
    const draft = await repository.find();
    draft.put({
      currentCommit: BASE_COMMIT,
      baseEntries: [{ path: 'README.md', kind: 'file' }],
      now: new Date(),
      path: 'README.md',
      size: 1,
    });
    await repository.save(draft, new Map([['README.md', new Uint8Array([1])]]));

    const view = await handler.execute();

    expect(view).toEqual({
      baseCommit: null,
      currentCommit: BASE_COMMIT,
      version: 2,
      files: [],
      problems: [],
      skillProblems: [],
      judged: true,
      notJudgedReason: null,
      movedUpstream: [],
    });
    expect(repository.contents.size).toBe(0);
  });

  it('works on an empty Draft and reads nothing from the Clone', async () => {
    const view = await handler.execute();

    expect(view).toMatchObject({ files: [], version: 1 });
    expect(definitions.listTreeCalls).toBe(0);
  });
});
