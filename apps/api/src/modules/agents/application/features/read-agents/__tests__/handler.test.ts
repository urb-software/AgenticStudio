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
              ? { path, status: 'found' as const, text: files[path]! }
              : { path, status: 'missing' as const },
          ),
        },
      ),
    ),
    readBlobs: vi.fn((): Promise<DefinitionsBlobsResult> =>
      Promise.resolve({ status: 'read', files: [] }),
    ),
  } satisfies DefinitionsFiles;
  const defaults: ProjectDefaultAgents = {
    forProject: () =>
      Promise.resolve(script.project ?? { status: 'found', kind: 'code', agent: null }),
  };
  return { fake, handler: new ReadAgentsHandler(fake, defaults) };
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
            { path: 'agents/b-binary/AGENT.md', status: 'found', text: '�x' },
            { path: 'agents/c-big/AGENT.md', status: 'too_large' },
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
