import { beforeEach, describe, expect, it } from 'vitest';
import { AgentDraft } from '../../../../domain/entities/agent-draft.js';
import { InMemoryAgentDraftRepository } from '../../../../domain/repositories/__tests__/in-memory-agent-draft-repository.js';
import {
  BASE_COMMIT,
  FakeDefinitionsFiles,
  NEXT_COMMIT,
  type FakeCommitFile,
} from '../../../__tests__/fake-definitions-files.js';
import { AgentDraftReader } from '../../../agent-draft-reader.js';
import { GetAgentDraftHandler } from '../handler.js';

const NOW = new Date('2026-11-25T10:00:00.000Z');

const agentFile = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does the ${name} work\nprovider: codex\n${extra}---\nWork as ${name}.\n`;

const BASE_FILES: Record<string, FakeCommitFile> = {
  'README.md': 'top\n',
  'agents/reviewer/AGENT.md': agentFile('reviewer'),
  'agents/reviewer/notes.txt': 'notes\n',
  'agents/broken/AGENT.md': 'no front matter at all\n',
  'docs/a.md': 'a\n',
};

describe('GetAgentDraftHandler', () => {
  let definitions: FakeDefinitionsFiles;
  let repository: InMemoryAgentDraftRepository;
  let handler: GetAgentDraftHandler;

  beforeEach(() => {
    definitions = new FakeDefinitionsFiles(BASE_FILES);
    repository = new InMemoryAgentDraftRepository();
    handler = new GetAgentDraftHandler(repository, new AgentDraftReader(definitions, repository));
  });

  /** Writes to the Draft as the write features do, at the base commit. */
  async function draftWith(
    steps: (
      draft: AgentDraft,
      facts: { currentCommit: string; baseEntries: ReturnType<typeof entriesOf>; now: Date },
    ) => void,
    contents: Record<string, string> = {},
  ) {
    const draft = await repository.find();
    steps(draft, { currentCommit: BASE_COMMIT, baseEntries: entriesOf(BASE_FILES), now: NOW });
    await repository.save(
      draft,
      new Map(Object.entries(contents).map(([path, text]) => [path, Buffer.from(text)])),
    );
  }

  function entriesOf(files: Record<string, FakeCommitFile>) {
    return Object.keys(files).map((path) => ({ path, kind: 'file' as const }));
  }

  it('shows an empty Draft with the current commit and nothing else', async () => {
    await expect(handler.execute()).resolves.toEqual({
      baseCommit: null,
      currentCommit: BASE_COMMIT,
      version: 0,
      files: [],
      problems: [],
      movedUpstream: [],
    });
    expect(definitions.listTreeCalls).toBe(0);
  });

  it('shows the changes with the base commit and the version, and no problem for a valid agent', async () => {
    await draftWith(
      (draft, facts) => {
        draft.put({ ...facts, path: 'agents/new/AGENT.md', size: agentFile('new').length });
        draft.move({ ...facts, from: 'README.md', to: 'docs/README.md', size: 4 });
      },
      { 'agents/new/AGENT.md': agentFile('new') },
    );

    const view = await handler.execute();

    expect(view).toMatchObject({
      baseCommit: BASE_COMMIT,
      currentCommit: BASE_COMMIT,
      version: 2,
      problems: [],
      movedUpstream: [],
    });
    expect(view.files).toEqual([
      { path: 'README.md', change: 'deleted', size: 0, movedFrom: null },
      {
        path: 'agents/new/AGENT.md',
        change: 'added',
        size: agentFile('new').length,
        movedFrom: null,
      },
      { path: 'docs/README.md', change: 'added', size: 4, movedFrom: 'README.md' },
    ]);
  });

  describe('problems', () => {
    it('flags a file with a forbidden key, which is saved all the same', async () => {
      const text = agentFile('new', 'tools: Bash\n');
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'agents/new/AGENT.md', size: text.length });
        },
        { 'agents/new/AGENT.md': text },
      );

      const { problems } = await handler.execute();

      expect(problems).toEqual([
        {
          agent: 'new',
          code: 'forbidden_key',
          path: 'agents/new/AGENT.md',
          key: 'tools',
          message: expect.stringContaining('tools'),
        },
      ]);
    });

    it('judges a modified agent file on the Draft content, not the base one', async () => {
      const text = 'now without front matter\n';
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'agents/reviewer/AGENT.md', size: text.length });
        },
        { 'agents/reviewer/AGENT.md': text },
      );

      const { problems } = await handler.execute();

      expect(problems.map((problem) => [problem.agent, problem.code, problem.path])).toEqual([
        ['reviewer', 'front_matter_missing', 'agents/reviewer/AGENT.md'],
      ]);
    });

    it('judges an agent whose other file changed against its AGENT.md at the base', async () => {
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'agents/reviewer/extra.txt', size: 1 });
        },
        { 'agents/reviewer/extra.txt': 'x' },
      );

      await expect(handler.execute()).resolves.toMatchObject({ problems: [] });
    });

    it('judges only the folders the Draft touches, so an agent already broken at the base is left alone', async () => {
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'docs/a.md', size: 1 });
          draft.put({ ...facts, path: 'agents/reviewer/extra.txt', size: 1 });
        },
        { 'docs/a.md': 'b', 'agents/reviewer/extra.txt': 'x' },
      );

      const { problems } = await handler.execute();

      expect(problems.filter((problem) => problem.agent === 'broken')).toEqual([]);
    });

    it('flags a deleted entry file and a new folder with none, naming the folder for a folder problem', async () => {
      await draftWith(
        (draft, facts) => {
          draft.delete({ ...facts, path: 'agents/reviewer/AGENT.md' });
          draft.put({ ...facts, path: 'agents/fresh/readme.md', size: 1 });
        },
        { 'agents/fresh/readme.md': 'x' },
      );

      const { problems } = await handler.execute();

      expect(problems.map((problem) => [problem.agent, problem.code, problem.path])).toEqual([
        ['fresh', 'entry_missing', 'agents/fresh/AGENT.md'],
        ['reviewer', 'entry_missing', 'agents/reviewer/AGENT.md'],
      ]);
    });

    it('flags a folder name the validation refuses, with the folder as the place', async () => {
      const text = agentFile('Bad_Name');
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'agents/Bad_Name/AGENT.md', size: text.length });
        },
        { 'agents/Bad_Name/AGENT.md': text },
      );

      const { problems } = await handler.execute();

      expect(problems.find((problem) => problem.code === 'name_invalid')).toMatchObject({
        agent: 'Bad_Name',
        path: 'agents/Bad_Name',
      });
    });

    it('treats an AGENT.md that is not UTF-8 text as unreadable', async () => {
      await draftWith((draft, facts) => {
        draft.put({ ...facts, path: 'agents/new/AGENT.md', size: 3 });
      });
      repository.contents.set('agents/new/AGENT.md', Buffer.from([0xff, 0xfe, 0x00]));

      const { problems } = await handler.execute();

      expect(problems.map((problem) => problem.code)).toEqual(['entry_unreadable']);
    });

    it('has none when the Clone cannot be read, and still shows the files', async () => {
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'agents/new/AGENT.md', size: 3 });
        },
        { 'agents/new/AGENT.md': 'bad' },
      );
      definitions.unavailable = 'unsupported_platform';

      const view = await handler.execute();

      expect(view.problems).toEqual([]);
      expect(view.movedUpstream).toEqual([]);
      expect(view.files).toHaveLength(1);
    });

    it('has none when the base tree was cut, since it would be judged on part of it', async () => {
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'agents/new/AGENT.md', size: 3 });
        },
        { 'agents/new/AGENT.md': 'bad' },
      );
      definitions.truncated = true;

      await expect(handler.execute()).resolves.toMatchObject({ problems: [] });
    });
  });

  describe('moved upstream', () => {
    beforeEach(() => {
      // The Repository moves on: README.md changes, docs/a.md stays, a.md's neighbour is new.
      definitions.commit(NEXT_COMMIT, {
        ...BASE_FILES,
        'README.md': 'top changed upstream\n',
        'docs/new.md': 'upstream copy\n',
      });
      definitions.head = NEXT_COMMIT;
    });

    it('lists the Draft paths whose blob differs between the base and the current commit', async () => {
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'README.md', size: 1 });
          draft.put({ ...facts, path: 'docs/a.md', size: 1 });
          draft.put({ ...facts, path: 'docs/new.md', size: 1 });
          draft.put({ ...facts, path: 'docs/mine.md', size: 1 });
        },
        { 'README.md': 'x', 'docs/a.md': 'x', 'docs/new.md': 'x', 'docs/mine.md': 'x' },
      );

      const view = await handler.execute();

      expect(view.baseCommit).toBe(BASE_COMMIT);
      expect(view.currentCommit).toBe(NEXT_COMMIT);
      // README.md changed upstream and docs/new.md appeared there; the others did not change.
      expect(view.movedUpstream).toEqual(['README.md', 'docs/new.md']);
    });

    it('lists a path whose only upstream change is the executable bit', async () => {
      definitions.commit(NEXT_COMMIT, { ...BASE_FILES, 'docs/a.md': { executable: 'a\n' } });
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'docs/a.md', size: 1 });
        },
        { 'docs/a.md': 'x' },
      );

      await expect(handler.execute()).resolves.toMatchObject({ movedUpstream: ['docs/a.md'] });
    });

    it('lists a path the Draft deletes when it was removed upstream', async () => {
      definitions.commit(NEXT_COMMIT, { 'README.md': 'top\n' });
      await draftWith((draft, facts) => {
        draft.delete({ ...facts, path: 'docs/a.md' });
      });

      await expect(handler.execute()).resolves.toMatchObject({ movedUpstream: ['docs/a.md'] });
    });

    it('is empty while the Repository is still at the base commit', async () => {
      definitions.head = BASE_COMMIT;
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'README.md', size: 1 });
        },
        { 'README.md': 'x' },
      );

      await expect(handler.execute()).resolves.toMatchObject({ movedUpstream: [] });
    });

    it('is empty when the Clone cannot name the blobs', async () => {
      await draftWith(
        (draft, facts) => {
          draft.put({ ...facts, path: 'README.md', size: 1 });
        },
        { 'README.md': 'x' },
      );
      definitions.commits.delete(NEXT_COMMIT);

      await expect(handler.execute()).resolves.toMatchObject({ movedUpstream: [] });
    });
  });

  it('shows no current commit when the Repository is not connected', async () => {
    definitions.connected = false;

    await expect(handler.execute()).resolves.toMatchObject({ currentCommit: null });
  });
});
