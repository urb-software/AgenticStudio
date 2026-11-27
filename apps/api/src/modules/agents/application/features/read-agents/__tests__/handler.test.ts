import { MAX_FILE_BYTES, RESERVED_AGENT_NAMES } from '@agentic-studio/agent-definitions';
import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsBlobsResult,
  ProjectDefaultAgent,
  ProjectDefaultAgents,
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../../projects/contracts/index.js';
import { AgentsReader } from '../../../agents-reader.js';
import { MAX_ON_DEMAND_SKILLS, SkillsReader } from '../../../skills-reader.js';
import { MAX_LISTED_AGENTS, ReadAgentsHandler } from '../handler.js';

const COMMIT = 'a'.repeat(40);

const VALID = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}\nprovider: codex\n${extra}---\nInstructions of ${name}.\n`;

interface Scripted {
  snapshot?: DefinitionsSnapshot | null;
  tree?: DefinitionsTreeResult;
  files?: Record<string, string>;
  readFiles?: DefinitionsFilesResult;
  project?: ProjectDefaultAgent;
}

/** A scripted `DefinitionsFiles`: the tree and the text of the files it holds. */
function scripted(script: Scripted) {
  const files = script.files ?? {};
  const fake = {
    snapshot: vi.fn(() =>
      Promise.resolve(
        script.snapshot === undefined
          ? { state: 'ready' as const, commit: COMMIT }
          : script.snapshot,
      ),
    ),
    listTree: vi.fn((): Promise<DefinitionsTreeResult> =>
      Promise.resolve(script.tree ?? { status: 'listed', entries: [], truncated: false }),
    ),
    readFiles: vi.fn((_commit: string, paths: readonly string[]): Promise<DefinitionsFilesResult> =>
      Promise.resolve(
        script.readFiles ?? {
          status: 'read',
          files: paths.map((path) =>
            path in files
              ? {
                  path,
                  status: 'found' as const,
                  text: files[path]!,
                  size: files[path]!.length,
                  binary: false,
                }
              : { path, status: 'missing' as const, size: 0 as const },
          ),
        },
      ),
    ),
    readBlobs: vi.fn((): Promise<DefinitionsBlobsResult> =>
      Promise.resolve({ status: 'read', files: [] }),
    ),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  const defaults: ProjectDefaultAgents = {
    forProject: () =>
      Promise.resolve(script.project ?? { status: 'found', kind: 'code', agent: null }),
  };
  const reader = new AgentsReader(fake, new SkillsReader(fake));
  return { fake, handler: new ReadAgentsHandler(reader, defaults), reader };
}

const file = (path: string, size = 10): DefinitionsTreeEntry => ({
  path,
  kind: 'file',
  size,
  executable: false,
});
const listed = (...entries: DefinitionsTreeEntry[]): DefinitionsTreeResult => ({
  status: 'listed',
  entries,
  truncated: false,
});

describe('ReadAgentsHandler', () => {
  describe('the built-in Default agents', () => {
    it('are listed without a definitions Repository, with the reason null', async () => {
      const { handler, fake } = scripted({ snapshot: null });

      const result = await handler.execute();

      expect(result).toMatchObject({ commit: null, repository: null, truncated: false });
      expect(result.agents).toEqual([
        {
          name: 'default-claude-code',
          description: expect.stringContaining('Claude Code') as string,
          provider: 'claude_code',
          model: 'default',
          source: 'built_in',
          usable: true,
          problems: [],
          skills: [],
          instructions: '',
          files: [],
        },
        expect.objectContaining({ name: 'default-codex', provider: 'codex', source: 'built_in' }),
      ]);
      expect(fake.listTree).not.toHaveBeenCalled();
    });

    it('carry the names the validation reserves', async () => {
      const { handler } = scripted({ snapshot: null });

      const { agents } = await handler.execute();

      expect(agents.map((agent) => agent.name).sort()).toEqual(
        RESERVED_AGENT_NAMES.filter((reserved) => reserved.startsWith('default-')).sort(),
      );
    });

    it('can be read one by one', async () => {
      const { handler } = scripted({ snapshot: null });

      const { agents } = await handler.execute({ name: 'default-codex' });

      expect(agents.map((agent) => agent.name)).toEqual(['default-codex']);
    });
  });

  describe('a ready Repository', () => {
    it('lists the valid agent with its fields, instructions and files, after the built-ins', async () => {
      const { handler, fake } = scripted({
        tree: listed(file('agents/reviewer/AGENT.md', 120), file('agents/reviewer/notes.txt', 7)),
        files: { 'agents/reviewer/AGENT.md': VALID('reviewer') },
      });

      const result = await handler.execute();

      expect(result.commit).toBe(COMMIT);
      expect(result.repository).toEqual({ state: 'ready', note: null });
      expect(result.truncated).toBe(false);
      expect(result.agents.map((agent) => agent.name)).toEqual([
        'default-claude-code',
        'default-codex',
        'reviewer',
      ]);
      expect(result.agents[2]).toEqual({
        name: 'reviewer',
        description: 'Does reviewer',
        provider: 'codex',
        model: 'default',
        source: 'definitions',
        usable: true,
        problems: [],
        skills: [],
        instructions: 'Instructions of reviewer.\n',
        files: [
          { path: 'AGENT.md', size: 120 },
          { path: 'notes.txt', size: 7 },
        ],
      });
      expect(fake.listTree).toHaveBeenCalledWith(COMMIT);
      expect(fake.readFiles).toHaveBeenCalledWith(
        COMMIT,
        ['agents/reviewer/AGENT.md'],
        MAX_FILE_BYTES,
      );
    });

    it('lists an invalid agent as not usable, with each problem and its place', async () => {
      const { handler } = scripted({
        tree: listed(file('agents/broken/AGENT.md', 40), file('agents/broken/.claude/x', 3)),
        files: {
          'agents/broken/AGENT.md': '---\nname: broken\ndescription: d\nprovider: nope\n---\nx',
        },
      });

      const { agents } = await handler.execute();
      const broken = agents.find((agent) => agent.name === 'broken');

      expect(broken).toMatchObject({
        description: null,
        provider: null,
        model: null,
        source: 'definitions',
        usable: false,
        instructions: '',
      });
      expect(broken?.problems.map((problem) => `${problem.code}@${problem.path}`).sort()).toEqual([
        'cli_config_path@.claude/x',
        'provider_unknown@AGENT.md',
      ]);
      expect(broken?.files).toEqual([
        { path: 'AGENT.md', size: 40 },
        { path: '.claude/x', size: 3 },
      ]);
    });

    it('refuses an agent whose name is a built-in one, with that reason', async () => {
      const { handler } = scripted({
        tree: listed(file('agents/default-codex/AGENT.md')),
        files: { 'agents/default-codex/AGENT.md': VALID('default-codex') },
      });

      const { agents } = await handler.execute();
      const definitions = agents.filter((agent) => agent.source === 'definitions');

      expect(definitions).toHaveLength(1);
      expect(definitions[0]).toMatchObject({ usable: false });
      expect(definitions[0]?.problems.map((problem) => problem.code)).toEqual(['name_reserved']);
    });

    it('refuses a folder with no entry file, and one with a binary or oversized entry file', async () => {
      const { handler } = scripted({
        tree: listed(
          file('agents/a-empty/readme.txt'),
          file('agents/b-binary/AGENT.md', 4),
          file('agents/c-big/AGENT.md', MAX_FILE_BYTES + 1),
        ),
        files: { 'agents/b-binary/AGENT.md': '�x' },
        readFiles: {
          status: 'read',
          files: [
            {
              path: 'agents/b-binary/AGENT.md',
              status: 'found',
              text: '�x',
              size: 2,
              binary: true,
            },
            { path: 'agents/c-big/AGENT.md', status: 'too_large', size: 2_000_000 },
          ],
        },
      });

      const { agents } = await handler.execute();
      const codes = (name: string) =>
        agents.find((agent) => agent.name === name)?.problems.map((problem) => problem.code);

      expect(codes('a-empty')).toEqual(['entry_missing']);
      expect(codes('b-binary')).toEqual(['entry_unreadable']);
      expect(codes('c-big')).toEqual(['file_too_large']);
    });

    it('refuses a big non-UTF-8 entry file under the limit as unreadable, not too large', async () => {
      const { handler } = scripted({
        tree: listed(file('agents/d-600k/AGENT.md', 600_000)),
        readFiles: {
          status: 'read',
          files: [
            {
              path: 'agents/d-600k/AGENT.md',
              status: 'found',
              // Each invalid byte arrives as a 3-byte replacement character.
              text: '�'.repeat(600_000),
              size: 600_000,
              binary: true,
            },
          ],
        },
      });

      const { agents } = await handler.execute();

      expect(
        agents.find((agent) => agent.name === 'd-600k')?.problems.map((problem) => problem.code),
      ).toEqual(['entry_unreadable']);
    });

    it('lists at most 200 agent folders and says so', async () => {
      const entries = Array.from({ length: MAX_LISTED_AGENTS + 1 }, (_, index) =>
        file(`agents/a${String(index).padStart(3, '0')}/AGENT.md`),
      );
      const { handler, fake } = scripted({ tree: listed(...entries) });

      const result = await handler.execute();

      expect(result.truncated).toBe(true);
      expect(result.agents.filter((agent) => agent.source === 'definitions')).toHaveLength(
        MAX_LISTED_AGENTS,
      );
      expect(fake.readFiles.mock.calls[0]?.[1]).toHaveLength(MAX_LISTED_AGENTS);
    });

    it('does not judge the last folder of a cut listing, which may be partial', async () => {
      const { handler } = scripted({
        tree: {
          status: 'listed',
          entries: [file('agents/a/AGENT.md'), file('agents/b/AGENT.md')],
          truncated: true,
        },
        files: { 'agents/a/AGENT.md': VALID('a') },
      });

      const result = await handler.execute();

      expect(result.truncated).toBe(true);
      expect(
        result.agents.filter((agent) => agent.source === 'definitions').map((a) => a.name),
      ).toEqual(['a']);
    });

    it('reads one agent only, also beyond the first 200', async () => {
      const entries = Array.from({ length: MAX_LISTED_AGENTS + 5 }, (_, index) =>
        file(`agents/a${String(index).padStart(3, '0')}/AGENT.md`),
      );
      const { handler, fake } = scripted({
        tree: listed(...entries),
        files: { 'agents/a204/AGENT.md': VALID('a204') },
      });

      const { agents } = await handler.execute({ name: 'a204' });

      expect(agents.map((agent) => agent.name)).toEqual(['a204']);
      expect(fake.readFiles).toHaveBeenCalledWith(COMMIT, ['agents/a204/AGENT.md'], MAX_FILE_BYTES);
    });

    it('answers no agent for an unknown name', async () => {
      const { handler } = scripted({
        tree: listed(file('agents/a/AGENT.md')),
        files: { 'agents/a/AGENT.md': VALID('a') },
      });

      await expect(handler.execute({ name: 'nope' })).resolves.toMatchObject({ agents: [] });
    });

    it('ignores the skills folder and anything outside agents', async () => {
      const { handler, fake } = scripted({ tree: listed(file('skills/s/SKILL.md')) });

      const { agents } = await handler.execute();

      expect(agents.every((agent) => agent.source === 'built_in')).toBe(true);
      expect(fake.readFiles).not.toHaveBeenCalled();
    });
  });

  describe('a Repository that is not ready', () => {
    it('shows the last known list with a note, at the commit the Clone holds', async () => {
      const { handler } = scripted({
        snapshot: { state: 'failed', commit: COMMIT },
        tree: listed(file('agents/a/AGENT.md')),
        files: { 'agents/a/AGENT.md': VALID('a') },
      });

      const result = await handler.execute();

      expect(result.commit).toBe(COMMIT);
      expect(result.repository).toEqual({
        state: 'failed',
        note: expect.stringContaining('failed') as string,
      });
      expect(result.agents.map((agent) => agent.name)).toContain('a');
    });

    it.each(['awaiting_key', 'awaiting_host_key', 'connecting', 'failed'] as const)(
      'shows only the built-ins with the reason when %s and there is no Clone',
      async (state) => {
        const { handler, fake } = scripted({ snapshot: { state, commit: null } });

        const result = await handler.execute();

        expect(result.commit).toBeNull();
        expect(result.repository?.state).toBe(state);
        expect(result.repository?.note).toEqual(expect.any(String));
        expect(result.agents.every((agent) => agent.source === 'built_in')).toBe(true);
        expect(fake.listTree).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['repository_not_ready', 'Clone'],
      ['unsupported_platform', 'Linux'],
      ['failed', 'could not be read'],
    ] as const)('says why when the Clone cannot be read (%s)', async (status, words) => {
      const { handler } = scripted({ tree: { status } });

      const result = await handler.execute();

      expect(result.commit).toBeNull();
      expect(result.repository?.note).toContain(words);
      expect(result.agents.every((agent) => agent.source === 'built_in')).toBe(true);
    });

    it('says why when the files cannot be read', async () => {
      const { handler } = scripted({
        tree: listed(file('agents/a/AGENT.md')),
        readFiles: { status: 'failed' },
      });

      const result = await handler.execute();

      expect(result.commit).toBeNull();
      expect(result.repository?.note).toContain('could not be read');
    });
  });

  it('reflects a new commit on the next call, since nothing is stored', async () => {
    const snapshot = { state: 'ready' as const, commit: COMMIT };
    const next = 'b'.repeat(40);
    const { handler, fake } = scripted({
      tree: listed(file('agents/a/AGENT.md')),
      files: { 'agents/a/AGENT.md': VALID('a') },
    });
    await handler.execute();
    fake.snapshot.mockResolvedValueOnce({ ...snapshot, commit: next });

    const second = await handler.execute();

    expect(second.commit).toBe(next);
    expect(fake.listTree).toHaveBeenLastCalledWith(next);
  });

  describe('the memo of judged lists', () => {
    const at = (commit: string) => ({ state: 'ready' as const, commit });
    const one = () =>
      scripted({
        tree: listed(file('agents/a/AGENT.md')),
        files: { 'agents/a/AGENT.md': VALID('a') },
      });

    it('starts no read at a commit it has judged, for the list or for one agent', async () => {
      const { handler, fake } = one();

      const first = await handler.execute();
      const again = await handler.execute();
      const detail = await handler.execute({ name: 'a' });

      expect(again).toEqual(first);
      expect(detail.agents.map((agent) => agent.name)).toEqual(['a']);
      expect(fake.listTree).toHaveBeenCalledTimes(1);
      expect(fake.readFiles).toHaveBeenCalledTimes(1);
    });

    it('keeps the four latest commits, the least recently used going first', async () => {
      const { handler, fake } = one();
      const commits = ['1', '2', '3', '4', '5'].map((digit) => digit.repeat(40));
      for (const commit of commits.slice(0, 4)) {
        fake.snapshot.mockResolvedValueOnce(at(commit));
        await handler.execute();
      }
      fake.snapshot.mockResolvedValueOnce(at(commits[0]!));
      await handler.execute();
      fake.snapshot.mockResolvedValueOnce(at(commits[4]!));
      await handler.execute();
      expect(fake.listTree).toHaveBeenCalledTimes(5);

      fake.snapshot.mockResolvedValueOnce(at(commits[0]!));
      await handler.execute();
      expect(fake.listTree).toHaveBeenCalledTimes(5);
      fake.snapshot.mockResolvedValueOnce(at(commits[1]!));
      await handler.execute();
      expect(fake.listTree).toHaveBeenCalledTimes(6);
    });

    it('keeps nothing of a read that failed', async () => {
      const { handler, fake } = scripted({ tree: { status: 'failed' } });

      await handler.execute();
      await handler.execute();

      expect(fake.listTree).toHaveBeenCalledTimes(2);
    });
  });

  describe('the agents a Run of a Project offers', () => {
    const REVIEWER = 'agents/reviewer/AGENT.md';
    const BROKEN = 'agents/broken/AGENT.md';
    const repository = {
      tree: listed(file(REVIEWER), file(BROKEN)),
      files: { [REVIEWER]: VALID('reviewer'), [BROKEN]: '---\nname: broken\n---\nNo provider.\n' },
    };
    const offered = async (project: ProjectDefaultAgent) => {
      const { handler } = scripted({ ...repository, project });
      return (await handler.execute({ projectId: 'p' })).forRun;
    };

    it('are the usable agents only, built-in first, with the Default agent of Claude Code preselected', async () => {
      const result = await offered({ status: 'found', kind: 'code', agent: null });

      expect(result).toMatchObject({
        status: 'offered',
        preselected: 'default-claude-code',
        reason: null,
      });
      expect(result?.status === 'offered' && result.agents.map((agent) => agent.name)).toEqual([
        'default-claude-code',
        'default-codex',
        'reviewer',
      ]);
    });

    it('preselect the default of the Project when it is usable', async () => {
      await expect(
        offered({ status: 'found', kind: 'code', agent: 'reviewer' }),
      ).resolves.toMatchObject({
        preselected: 'reviewer',
        reason: null,
      });
    });

    it('judge the default where it is read: one with problems, or gone, gives the Default agent and a reason', async () => {
      for (const agent of ['broken', 'removed']) {
        const result = await offered({ status: 'found', kind: 'code', agent });

        expect(result).toMatchObject({ status: 'offered', preselected: 'default-claude-code' });
        expect(result).toEqual(expect.objectContaining({ reason: expect.stringContaining(agent) }));
      }
    });

    it('answer for no Project and for the definitions Project, which accepts no Run', async () => {
      await expect(offered({ status: 'project_not_found' })).resolves.toEqual({
        status: 'project_not_found',
      });
      await expect(offered({ status: 'found', kind: 'definitions', agent: null })).resolves.toEqual(
        { status: 'definitions_project' },
      );
    });

    it('are left out when no Project is asked about', async () => {
      const { handler } = scripted(repository);

      expect(await handler.execute()).not.toHaveProperty('forRun');
    });
  });
});

describe('the skills an agent names', () => {
  const SKILL = (name: string) =>
    `---\nname: ${name}\ndescription: Does ${name}\n---\nHow to ${name}.\n`;
  const agentFiles = (name: string, skills: string) => ({
    [`agents/${name}/AGENT.md`]: VALID(name, `skills: ${skills}\n`),
  });
  const entries = (...names: string[]) => names.map((name) => file(`agents/${name}/AGENT.md`));
  const skillEntries = (...names: string[]) => names.map((name) => file(`skills/${name}/SKILL.md`));

  it('answers skills: [] for the built-in agents and an agent without the key', async () => {
    const { handler, fake } = scripted({
      tree: listed(...entries('plain')),
      files: { 'agents/plain/AGENT.md': VALID('plain') },
    });

    const { agents } = await handler.execute();

    expect(agents.map((agent) => [agent.name, agent.skills, agent.usable])).toEqual([
      ['default-claude-code', [], true],
      ['default-codex', [], true],
      ['plain', [], true],
    ]);
    // No skill was looked at: the agent is judged exactly as before.
    expect(fake.listTree).toHaveBeenCalledTimes(1);
  });

  it('keeps an agent usable when every skill it names exists and is valid', async () => {
    const { handler } = scripted({
      tree: listed(...entries('worker'), ...skillEntries('review', 'test')),
      files: {
        ...agentFiles('worker', '[review, test]'),
        'skills/review/SKILL.md': SKILL('review'),
        'skills/test/SKILL.md': SKILL('test'),
      },
    });

    const { agents } = await handler.execute({ name: 'worker' });

    expect(agents[0]).toMatchObject({ usable: true, skills: ['review', 'test'], problems: [] });
  });

  it('makes an agent invalid when a named skill does not exist, naming the skill', async () => {
    const { handler } = scripted({
      tree: listed(...entries('worker'), ...skillEntries('review')),
      files: {
        ...agentFiles('worker', '[review, gone]'),
        'skills/review/SKILL.md': SKILL('review'),
      },
    });

    const { agents } = await handler.execute({ name: 'worker' });

    expect(agents[0]).toMatchObject({
      usable: false,
      description: null,
      skills: ['review', 'gone'],
      problems: [{ code: 'skill_missing', path: 'AGENT.md', key: 'gone' }],
    });
  });

  it('makes an agent invalid when a named skill is invalid, and compares names exactly', async () => {
    const { handler } = scripted({
      tree: listed(...entries('worker'), ...skillEntries('review', 'Other')),
      files: {
        ...agentFiles('worker', '[review, other]'),
        'skills/review/SKILL.md': '---\nname: review\n---\nno description\n',
        'skills/Other/SKILL.md': SKILL('Other'),
      },
    });

    const { agents } = await handler.execute({ name: 'worker' });

    expect(agents[0]?.problems.map((item) => [item.code, item.key])).toEqual([
      ['skill_invalid', 'review'],
      ['skill_missing', 'other'],
    ]);
  });

  it('lists the skills of an agent invalid for another reason, and none for a broken front matter', async () => {
    const { handler } = scripted({
      tree: listed(...entries('odd', 'broken')),
      files: {
        'agents/odd/AGENT.md': VALID('odd', 'skills: [review]\ncolour: red\n'),
        'agents/broken/AGENT.md': '---\nname: [x\n---\n',
      },
    });

    const { agents } = await handler.execute();

    expect(
      agents.filter((agent) => agent.source === 'definitions').map((a) => [a.name, a.skills]),
    ).toEqual([
      ['odd', ['review']],
      ['broken', []],
    ]);
  });

  it('never counts a skill as missing because the skills list was cut', async () => {
    const names = Array.from({ length: 205 }, (_, i) => `skill-${String(i).padStart(3, '0')}`);
    const { handler } = scripted({
      tree: listed(...entries('worker'), ...skillEntries(...names)),
      files: {
        ...agentFiles('worker', '[skill-204, skill-000]'),
        ...Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, SKILL(name)])),
      },
    });

    const { agents } = await handler.execute({ name: 'worker' });

    expect(agents[0]).toMatchObject({ usable: true, problems: [] });
  });

  it('fails closed with skill_invalid when a named skill cannot be read, and does not keep that answer', async () => {
    const { handler, fake } = scripted({
      tree: listed(...entries('worker'), ...skillEntries('review')),
      files: { ...agentFiles('worker', '[review]'), 'skills/review/SKILL.md': SKILL('review') },
    });
    const real = fake.readFiles.getMockImplementation()!;
    fake.readFiles.mockImplementation((commit: string, paths: readonly string[]) =>
      paths.some((path) => path.startsWith('skills/'))
        ? Promise.resolve({ status: 'failed' as const })
        : real(commit, paths),
    );

    const first = await handler.execute({ name: 'worker' });
    fake.readFiles.mockImplementation(real);
    const second = await handler.execute({ name: 'worker' });

    expect(first.agents[0]).toMatchObject({
      usable: false,
      problems: [{ code: 'skill_invalid', key: 'review' }],
    });
    expect(second.agents[0]).toMatchObject({ usable: true, problems: [] });
  });

  it('says who uses a skill: the agents of the commit that list it, valid or not, sorted', async () => {
    const { reader } = scripted({
      tree: listed(...entries('zed', 'alpha', 'other'), ...skillEntries('review')),
      files: {
        'agents/zed/AGENT.md': VALID('zed', 'skills: [review]\n'),
        'agents/alpha/AGENT.md': VALID('alpha', 'skills: [review]\ncolour: red\n'),
        'agents/other/AGENT.md': VALID('other'),
        'skills/review/SKILL.md': SKILL('review'),
      },
    });

    await expect(reader.skillUsers(COMMIT, 'review')).resolves.toEqual({
      users: ['alpha', 'zed'],
      truncated: false,
    });
    await expect(reader.skillUsers(COMMIT, 'unused')).resolves.toEqual({
      users: [],
      truncated: false,
    });
  });

  it('offers the Default agent with the reason when the default agent lost its skill', async () => {
    const { handler } = scripted({
      tree: listed(...entries('worker')),
      files: agentFiles('worker', '[gone]'),
      project: { status: 'found', kind: 'code', agent: 'worker' },
    });

    const { forRun } = await handler.execute({ projectId: 'p' });

    expect(forRun).toMatchObject({
      status: 'offered',
      preselected: 'default-claude-code',
      reason: expect.stringContaining('worker') as string,
    });
  });
});

describe('the skills an agent names, when the skills list is cut', () => {
  const SKILL = (name: string) =>
    `---\nname: ${name}\ndescription: Does ${name}\n---\nHow to ${name}.\n`;
  const skillName = (index: number) => `skill-${String(index).padStart(4, '0')}`;
  const manySkills = (count: number) => Array.from({ length: count }, (_, i) => skillName(i));
  const skillEntries = (names: string[]) => names.map((n) => file(`skills/${n}/SKILL.md`));
  const skillFiles = (names: string[]) =>
    Object.fromEntries(names.map((n) => [`skills/${n}/SKILL.md`, SKILL(n)]));
  const agent = (name: string, skills: string[]) => ({
    [`agents/${name}/AGENT.md`]: VALID(name, `skills: [${skills.join(', ')}]\n`),
  });
  const calls = (fake: ReturnType<typeof scripted>['fake']) =>
    fake.listTree.mock.calls.length + fake.readFiles.mock.calls.length;

  it('reads a named skill beyond the cut once per commit, for every agent and every request', async () => {
    const names = manySkills(205);
    const { handler, fake } = scripted({
      tree: listed(
        file('agents/one/AGENT.md'),
        file('agents/two/AGENT.md'),
        ...skillEntries(names),
      ),
      files: {
        ...agent('one', [skillName(204)]),
        ...agent('two', [skillName(204), skillName(203)]),
        ...skillFiles(names),
      },
    });

    const first = await handler.execute();
    const afterFirst = calls(fake);
    const second = await handler.execute();

    expect(first.agents.filter((a) => a.source === 'definitions').map((a) => a.usable)).toEqual([
      true,
      true,
    ]);
    expect(second.agents).toEqual(first.agents);
    expect(calls(fake)).toBe(afterFirst);
    const skillReads = fake.readFiles.mock.calls.filter(([, paths]) =>
      paths.some((path) => path.startsWith('skills/skill-0204')),
    );
    expect(skillReads).toHaveLength(1);
  });

  it('lists skills/ once for all the names beyond the cut', async () => {
    const names = manySkills(210);
    const { handler, fake } = scripted({
      tree: listed(file('agents/one/AGENT.md'), ...skillEntries(names)),
      files: {
        ...agent('one', [skillName(205), skillName(206), skillName(207)]),
        ...skillFiles(names),
      },
    });

    await handler.execute();

    const skillTrees = fake.listTree.mock.calls as unknown as [string, { directory?: string }?][];
    // One for the cut list, one for the named folders.
    expect(skillTrees.filter(([, options]) => options?.directory === 'skills')).toHaveLength(2);
  });

  it('answers the same on every request, alone or in the list, for names past the budget', async () => {
    const names = manySkills(200 + MAX_ON_DEMAND_SKILLS + 20);
    const beyond = names.slice(200);
    const agentNames = Array.from({ length: 12 }, (_, index) => `agent-${index}`);
    const files: Record<string, string> = { ...skillFiles(names) };
    agentNames.forEach((name, index) => {
      Object.assign(files, agent(name, beyond.slice(index * 20, index * 20 + 20)));
    });
    const { handler, fake } = scripted({
      tree: listed(...agentNames.map((n) => file(`agents/${n}/AGENT.md`)), ...skillEntries(names)),
      files,
    });

    const first = await handler.execute();
    const afterFirst = calls(fake);
    const second = await handler.execute();
    const alone = await handler.execute({ name: 'agent-11' });

    const refused = first.agents.filter((a) => a.source === 'definitions' && !a.usable);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((a) => a.problems.every((p) => p.code === 'skill_invalid'))).toBe(true);
    expect(second.agents).toEqual(first.agents);
    expect(alone.agents[0]).toEqual(first.agents.find((a) => a.name === 'agent-11'));
    expect(calls(fake)).toBe(afterFirst);
  });

  it('fails closed, and keeps that answer, when the listing of skills/ is itself cut', async () => {
    const { handler, fake } = scripted({
      tree: {
        status: 'listed',
        entries: [
          file('agents/worker/AGENT.md'),
          file('agents/zz/AGENT.md'),
          file('skills/a/SKILL.md'),
          file('skills/b/SKILL.md'),
        ],
        truncated: true,
      },
      files: { ...agent('worker', ['b']), ...skillFiles(['a', 'b']) },
    });

    const first = await handler.execute({ name: 'worker' });
    const afterFirst = calls(fake);
    const second = await handler.execute({ name: 'worker' });

    expect(first.agents[0]).toMatchObject({
      usable: false,
      problems: [{ code: 'skill_invalid', key: 'b' }],
    });
    expect(second.agents).toEqual(first.agents);
    expect(calls(fake)).toBe(afterFirst);
  });

  it('keeps nothing of a transient failure while reading the named folders', async () => {
    const names = manySkills(205);
    const { handler, fake } = scripted({
      tree: listed(file('agents/one/AGENT.md'), ...skillEntries(names)),
      files: { ...agent('one', [skillName(204)]), ...skillFiles(names) },
    });
    const real = fake.readFiles.getMockImplementation()!;
    fake.readFiles.mockImplementation((commit: string, paths: readonly string[]) =>
      paths.includes(`skills/${skillName(204)}/SKILL.md`)
        ? Promise.resolve({ status: 'failed' as const })
        : real(commit, paths),
    );

    const first = await handler.execute({ name: 'one' });
    fake.readFiles.mockImplementation(real);
    const second = await handler.execute({ name: 'one' });

    expect(first.agents[0]).toMatchObject({
      usable: false,
      problems: [{ code: 'skill_invalid', key: skillName(204) }],
    });
    expect(second.agents[0]).toMatchObject({ usable: true, problems: [] });
  });

  it('says whether the agents beyond the cut were not checked for the users of a skill', async () => {
    const { reader } = scripted({
      tree: { status: 'listed', entries: [file('agents/a/AGENT.md')], truncated: true },
      files: agent('a', ['review']),
    });

    await expect(reader.skillUsers(COMMIT, 'review')).resolves.toEqual({
      users: [],
      truncated: true,
    });
  });
  describe('the workflows that name an agent', () => {
    const WF = (name: string, agent: string) =>
      `---\nname: ${name}\ndescription: d\nsequence:\n  - id: a\n    kind: work\n    agent: ${agent}\n---\n`;

    const setup = () =>
      scripted({
        tree: listed(
          file('agents/builder/AGENT.md'),
          file('workflows/ship/WORKFLOW.md'),
          file('workflows/other/WORKFLOW.md'),
        ),
        files: {
          'agents/builder/AGENT.md': VALID('builder'),
          'workflows/ship/WORKFLOW.md': WF('ship', 'builder'),
          'workflows/other/WORKFLOW.md': WF('other', 'someone'),
        },
      });

    it('are named with the agent when asked', async () => {
      const { handler, fake } = setup();

      const result = await handler.execute({ name: 'builder', workflowUsers: true });

      expect(result.usedByWorkflows).toEqual(['ship']);
      expect(result.usedByWorkflowsTruncated).toBe(false);
      expect(fake.listTree).toHaveBeenCalledWith(COMMIT, { directory: 'workflows' });
    });

    it('are not read unless asked', async () => {
      const { handler, fake } = setup();

      const result = await handler.execute({ name: 'builder' });

      expect(result.usedByWorkflows).toEqual([]);
      expect(result.usedByWorkflowsTruncated).toBe(false);
      expect(fake.listTree).not.toHaveBeenCalledWith(COMMIT, { directory: 'workflows' });
    });

    it('are not read for a built-in agent or when nothing was read', async () => {
      const { handler, fake } = setup();

      const builtIn = await handler.execute({ name: 'default-codex', workflowUsers: true });

      expect(builtIn.usedByWorkflows).toEqual([]);
      expect(fake.listTree).not.toHaveBeenCalledWith(COMMIT, { directory: 'workflows' });
      const none = scripted({ snapshot: null });
      await expect(
        none.handler.execute({ name: 'builder', workflowUsers: true }),
      ).resolves.toMatchObject({ usedByWorkflows: [], usedByWorkflowsTruncated: false });
    });

    it('say they may be incomplete when the Clone cannot be read', async () => {
      const { handler, fake } = setup();
      fake.readFiles.mockImplementation((_commit: string, paths: readonly string[]) =>
        Promise.resolve(
          paths[0]?.startsWith('workflows/')
            ? { status: 'failed' as const }
            : {
                status: 'read' as const,
                files: paths.map((path) => ({
                  path,
                  status: 'found' as const,
                  text: VALID('builder'),
                  size: 10,
                  binary: false,
                })),
              },
        ),
      );

      const result = await handler.execute({ name: 'builder', workflowUsers: true });

      expect(result.usedByWorkflows).toEqual([]);
      expect(result.usedByWorkflowsTruncated).toBe(true);
    });
  });
});
