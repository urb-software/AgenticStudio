import { describe, expect, it } from 'vitest';
import { ReadAgentFolderAgentFolders } from '../../entry-points/contracts/agent-folders.js';
import { ReadAgentsAgentResolutions } from '../../entry-points/contracts/agent-resolutions.js';
import { InMemoryAgentDraftRepository } from '../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import { AgentDraftBaseReader } from '../agent-draft-base.js';
import { AgentDraftReader } from '../agent-draft-reader.js';
import { DeleteAgentDraftFileHandler } from '../features/delete-agent-draft-file/handler.js';
import { ListAgentFilesHandler } from '../features/list-agent-files/handler.js';
import { ReadAgentFolderHandler } from '../features/read-agent-folder/handler.js';
import { AgentsReader } from '../agents-reader.js';
import { ReadAgentsHandler } from '../features/read-agents/handler.js';
import { SkillsReader } from '../skills-reader.js';
import { SaveAgentDraftFileHandler } from '../features/save-agent-draft-file/handler.js';
import { BASE_COMMIT, FakeDefinitionsFiles } from './fake-definitions-files.js';

const agentFile = (name: string, instructions: string) =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: codex\n---\n${instructions}\n`;

const bytes = (text: string) => new TextEncoder().encode(text);

// A Draft is the operator's unpublished work: the agents list, the resolution of an agent for a
// Run, the hand-over of its folder and the file tree read only the Clone, so none of them changes
// after a Draft write.
describe('a Draft reaches no agent', () => {
  function setup() {
    const definitions = new FakeDefinitionsFiles({
      'agents/reviewer/AGENT.md': agentFile('reviewer', 'Review the change.'),
      'agents/reviewer/notes.txt': 'notes\n',
    });
    const repository = new InMemoryAgentDraftRepository();
    const reader = new AgentDraftReader(definitions, repository);
    const base = new AgentDraftBaseReader(definitions);
    const list = new ReadAgentsHandler(
      new AgentsReader(definitions, new SkillsReader(definitions)),
      {
        forProject: () => Promise.resolve({ status: 'found', kind: 'code', agent: null }),
      },
    );
    return {
      repository,
      list,
      resolutions: new ReadAgentsAgentResolutions(list),
      folders: new ReadAgentFolderAgentFolders(new ReadAgentFolderHandler(definitions)),
      files: new ListAgentFilesHandler(definitions),
      save: new SaveAgentDraftFileHandler(repository, base, reader),
      remove: new DeleteAgentDraftFileHandler(repository, base, reader),
    };
  }

  it('leaves the agents list, a resolution for a Run, a folder hand-over and the file tree unchanged', async () => {
    const { list, resolutions, folders, files, save, remove } = setup();
    const before = {
      list: await list.execute(),
      resolved: await resolutions.resolveForRun('reviewer'),
      added: await resolutions.resolveForRun('drafted'),
      folder: await folders.folderAt('reviewer', BASE_COMMIT),
      draftedFolder: await folders.folderAt('drafted', BASE_COMMIT),
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
    await expect(folders.folderAt('reviewer', BASE_COMMIT)).resolves.toEqual(before.folder);
    await expect(folders.folderAt('drafted', BASE_COMMIT)).resolves.toEqual(before.draftedFolder);
    await expect(files.execute()).resolves.toEqual(before.tree);
    expect(before.resolved).toMatchObject({
      status: 'resolved',
      agent: { instructions: 'Review the change.\n' },
    });
    expect(before.added).toEqual({ status: 'unknown' });
    expect(before.folder).toMatchObject({ status: 'found' });
    expect(before.draftedFolder).toEqual({ status: 'unavailable' });
  });
});
