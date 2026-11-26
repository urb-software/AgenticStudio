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
      skillProblems: [],
      judged: true,
      notJudgedReason: null,
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
      { path: 'README.md', change: 'deleted', size: 0, movedFrom: null, skill: null },
      {
        path: 'agents/new/AGENT.md',
        change: 'added',
        size: agentFile('new').length,
        movedFrom: null,
        skill: null,
      },
      { path: 'docs/README.md', change: 'added', size: 4, movedFrom: 'README.md', skill: null },
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

  describe('skills', () => {
    const skillFile = (name: string, extra = '') =>
      `---\nname: ${name}\ndescription: Does the ${name} thing\n${extra}---\nSteps.\n`;
    const SKILL_FILES: Record<string, FakeCommitFile> = {
      ...BASE_FILES,
      'skills/lint/SKILL.md': skillFile('lint'),
      'skills/lint/notes.md': 'notes\n',
      'skills/rotten/SKILL.md': 'no front matter\n',
      'agents/user/AGENT.md': agentFile('user', 'skills:\n  - lint\n'),
      'agents/stale/AGENT.md': agentFile('stale', 'skills:\n  - rotten\n'),
    };

    beforeEach(() => {
      definitions = new FakeDefinitionsFiles(SKILL_FILES);
      handler = new GetAgentDraftHandler(repository, new AgentDraftReader(definitions, repository));
    });

    const put = (path: string, text: string) =>
      draftWith(
        (draft, facts) => {
          draft.put({
            ...facts,
            baseEntries: entriesOf(SKILL_FILES),
            path,
            size: text.length,
          });
        },
        { [path]: text },
      );

    it('names the skill each Draft path belongs to', async () => {
      await draftWith(
        (draft, facts) => {
          const f = { ...facts, baseEntries: entriesOf(SKILL_FILES) };
          draft.put({ ...f, path: 'skills/new/SKILL.md', size: 1 });
          draft.put({ ...f, path: 'skills/new/deep/a.md', size: 1 });
          draft.put({ ...f, path: 'agents/new/AGENT.md', size: 1 });
        },
        { 'skills/new/SKILL.md': 'x', 'skills/new/deep/a.md': 'x', 'agents/new/AGENT.md': 'x' },
      );

      const { files } = await handler.execute();

      expect(files.map((file) => [file.path, file.skill])).toEqual([
        ['agents/new/AGENT.md', null],
        ['skills/new/SKILL.md', 'new'],
        ['skills/new/deep/a.md', 'new'],
      ]);
    });

    it('flags a skill with a forbidden key, which is saved all the same', async () => {
      await put('skills/lint/SKILL.md', skillFile('lint', 'tools: Bash\n'));

      const view = await handler.execute();

      expect(view.skillProblems).toEqual([
        {
          skill: 'lint',
          code: 'forbidden_key',
          path: 'skills/lint/SKILL.md',
          key: 'tools',
          message: expect.stringContaining('tools'),
        },
      ]);
      // The agent naming it is made invalid by it.
      expect(view.problems.map((p) => [p.agent, p.code, p.key])).toEqual([
        ['user', 'skill_invalid', 'lint'],
      ]);
    });

    it('flags a shell line in a Markdown file beside the entry file', async () => {
      await put('skills/lint/notes.md', '!`rm -rf /`\n');

      const { skillProblems } = await handler.execute();

      expect(skillProblems.map((p) => [p.skill, p.code, p.path])).toEqual([
        ['lint', 'shell_line', 'skills/lint/notes.md'],
      ]);
    });

    it('flags an agent that names a skill missing from the Draft, though the agent is untouched', async () => {
      await draftWith((draft, facts) => {
        const f = { ...facts, baseEntries: entriesOf(SKILL_FILES) };
        draft.delete({ ...f, path: 'skills/lint/SKILL.md' });
        draft.delete({ ...f, path: 'skills/lint/notes.md' });
      });

      const view = await handler.execute();

      expect(view.problems).toEqual([
        {
          agent: 'user',
          code: 'skill_missing',
          path: 'agents/user/AGENT.md',
          key: 'lint',
          message: expect.stringContaining('lint'),
        },
      ]);
      expect(view.skillProblems).toEqual([]);
    });

    it('flags a skill folder left without its entry file', async () => {
      await draftWith((draft, facts) => {
        draft.delete({
          ...facts,
          baseEntries: entriesOf(SKILL_FILES),
          path: 'skills/lint/SKILL.md',
        });
      });

      const { skillProblems } = await handler.execute();

      expect(skillProblems.map((p) => [p.skill, p.code, p.path])).toEqual([
        ['lint', 'entry_missing', 'skills/lint/SKILL.md'],
      ]);
    });

    it('has no problem for a new agent and the new skill it names, in one Draft', async () => {
      await draftWith(
        (draft, facts) => {
          const f = { ...facts, baseEntries: entriesOf(SKILL_FILES) };
          draft.put({ ...f, path: 'skills/fresh/SKILL.md', size: 1 });
          draft.put({ ...f, path: 'agents/fresh/AGENT.md', size: 1 });
        },
        {
          'skills/fresh/SKILL.md': skillFile('fresh'),
          'agents/fresh/AGENT.md': agentFile('fresh', 'skills:\n  - fresh\n'),
        },
      );

      await expect(handler.execute()).resolves.toMatchObject({ problems: [], skillProblems: [] });
    });

    it('leaves a skill and an agent already broken at the base alone when the Draft does not touch them', async () => {
      await put('skills/lint/extra.txt', 'x');

      await expect(handler.execute()).resolves.toMatchObject({ problems: [], skillProblems: [] });
    });

    it('judges the skills an edited agent names against the Draft', async () => {
      await put(
        'agents/new/AGENT.md',
        agentFile('new', 'skills:\n  - lint\n  - rotten\n  - nope\n'),
      );

      const { problems } = await handler.execute();

      expect(problems.map((p) => [p.agent, p.code, p.key])).toEqual([
        ['new', 'skill_invalid', 'rotten'],
        ['new', 'skill_missing', 'nope'],
      ]);
    });

    it('says it was not judged when the Clone cannot be read', async () => {
      await put('skills/lint/SKILL.md', 'bad');
      definitions.readFilesFails = true;

      await expect(handler.execute()).resolves.toMatchObject({
        problems: [],
        skillProblems: [],
        judged: false,
        notJudgedReason: 'clone_unreadable',
      });
    });

    it('says it was over the limits when more agents are read than one judgement allows', async () => {
      const many: Record<string, FakeCommitFile> = { ...SKILL_FILES };
      for (let index = 0; index < 501; index += 1) {
        many[`agents/a${index}/AGENT.md`] = agentFile(`a${index}`);
      }
      definitions = new FakeDefinitionsFiles(many);
      handler = new GetAgentDraftHandler(repository, new AgentDraftReader(definitions, repository));
      await put('skills/solo/SKILL.md', skillFile('solo'));

      await expect(handler.execute()).resolves.toMatchObject({
        problems: [],
        skillProblems: [],
        judged: false,
        notJudgedReason: 'over_limits',
      });
    });

    it('says it was over the limits when the entry files of the agents hold too many bytes', async () => {
      const big = 'x'.repeat(1024 * 1024 - 200);
      const many: Record<string, FakeCommitFile> = { ...SKILL_FILES };
      for (let index = 0; index < 17; index += 1) {
        many[`agents/b${index}/AGENT.md`] = agentFile(`b${index}`, `description2: ${big}\n`);
      }
      definitions = new FakeDefinitionsFiles(many);
      handler = new GetAgentDraftHandler(repository, new AgentDraftReader(definitions, repository));
      await put('skills/solo/SKILL.md', skillFile('solo'));

      await expect(handler.execute()).resolves.toMatchObject({
        judged: false,
        notJudgedReason: 'over_limits',
      });
    });

    describe('reading from Git', () => {
      let reads: string[][];
      beforeEach(() => {
        reads = [];
        const original = definitions.readFiles.bind(definitions);
        definitions.readFiles = (commit, paths, max) => {
          reads.push([...paths]);
          return original(commit, paths, max);
        };
      });
      const agentPaths = () => reads.flat().filter((path) => path.startsWith('agents/'));

      it('reads no agent file for a second read of the same Draft', async () => {
        await put('skills/solo/SKILL.md', skillFile('solo'));
        await handler.execute();
        expect(agentPaths().length).toBeGreaterThan(0);
        reads.length = 0;

        await handler.execute();

        expect(agentPaths()).toEqual([]);
      });

      it('reads only the agents that name a touched skill, once the skills they name are known', async () => {
        await put('skills/solo/SKILL.md', skillFile('solo'));
        await handler.execute();
        reads.length = 0;
        await put('skills/lint/notes.md', 'changed\n');

        await handler.execute();

        expect(agentPaths()).toEqual(['agents/user/AGENT.md']);
      });
    });

    it('treats a skill file with a NUL, or bytes that are not UTF-8, as unreadable like the Clone does', async () => {
      await draftWith((draft, facts) => {
        const f = { ...facts, baseEntries: entriesOf(SKILL_FILES) };
        draft.put({ ...f, path: 'skills/lint/SKILL.md', size: 4 });
        draft.put({ ...f, path: 'skills/lint/notes.md', size: 3 });
      }, {});
      repository.contents.set('skills/lint/SKILL.md', Buffer.from([0x2d, 0x2d, 0xc3, 0x28]));
      repository.contents.set('skills/lint/notes.md', Buffer.from([0x61, 0x00, 0x62]));

      const { skillProblems } = await handler.execute();

      expect(skillProblems.map((p) => [p.code, p.path]).sort()).toEqual([
        ['entry_unreadable', 'skills/lint/SKILL.md'],
        ['entry_unreadable', 'skills/lint/notes.md'],
      ]);
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
