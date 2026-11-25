import { describe, expect, it } from 'vitest';
import { ReadAgentsAgentResolutions } from '../../entry-points/contracts/agent-resolutions.js';
import { InMemoryAgentDraftRepository } from '../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { AgentDraftBaseReader } from '../agent-draft-base.js';
import { AgentDraftReader } from '../agent-draft-reader.js';
import { DeleteAgentDraftFileHandler } from '../features/delete-agent-draft-file/handler.js';
import { ListAgentFilesHandler } from '../features/list-agent-files/handler.js';
import { ReadAgentsHandler } from '../features/read-agents/handler.js';
import { SaveAgentDraftFileHandler } from '../features/save-agent-draft-file/handler.js';
import { FakeDefinitionsFiles } from './fake-definitions-files.js';

const agentFile = (name: string, instructions: string) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: codex\n---\n${instructions}\n`;

const bytes = (text: string) => new TextEncoder().encode(text);

// A Draft is the operator's unpublished work: the agents list, the resolution of an agent for a
// Run and the file tree read only the Clone, so none of them changes after a Draft write.
describe('a Draft reaches no agent', () => {
  function setup() {
    const definitions = new FakeDefinitionsFiles({
      'agents/reviewer/AGENT.md': agentFile('reviewer', 'Review the change.'),
      'agents/reviewer/notes.txt': 'notes\n',
    });
    const repository = new InMemoryAgentDraftRepository();
    const reader = new AgentDraftReader(definitions, repository);
    const base = new AgentDraftBaseReader(definitions);
    const list = new ReadAgentsHandler(definitions, {
      forProject: () => Promise.resolve({ status: 'found', kind: 'code', agent: null }),
    });
    return {
      repository,
      list,
      resolutions: new ReadAgentsAgentResolutions(list),
      files: new ListAgentFilesHandler(definitions),
      save: new SaveAgentDraftFileHandler(repository, base, reader),
      remove: new DeleteAgentDraftFileHandler(repository, base, reader),
    };
  }

  it('leaves the agents list, a resolution for a Run and the file tree unchanged', async () => {
    const { list, resolutions, files, save, remove } = setup();
    const before = {
      list: await list.execute(),
      resolved: await resolutions.resolveForRun('reviewer'),
      added: await resolutions.resolveForRun('drafted'),
      tree: await files.execute(),
    };

    await save.execute({
      path: 'agents/reviewer/AGENT.md',
      content: bytes(agentFile('reviewer', 'Changed in the Draft.')),
    });
    await save.execute({
      path: 'agents/drafted/AGENT.md',
      content: bytes(agentFile('drafted', 'Only in the Draft.')),
    });
    await remove.execute({ path: 'agents/reviewer/notes.txt' });

    await expect(list.execute()).resolves.toEqual(before.list);
    await expect(resolutions.resolveForRun('reviewer')).resolves.toEqual(before.resolved);
    await expect(resolutions.resolveForRun('drafted')).resolves.toEqual(before.added);
    await expect(files.execute()).resolves.toEqual(before.tree);
    expect(before.resolved).toMatchObject({
      status: 'resolved',
      agent: { instructions: 'Review the change.\n' },
    });
    expect(before.added).toEqual({ status: 'unknown' });
  });
});
