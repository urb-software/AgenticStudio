import { MAX_FILE_BYTES, MAX_FILES, MAX_FOLDER_BYTES } from '@agentic-studio/agent-definitions';
import { describe, expect, it, vi } from 'vitest';
import type {
  DefinitionsFiles,
  DefinitionsFilesResult,
  DefinitionsSnapshot,
  DefinitionsTreeEntry,
  DefinitionsTreeResult,
} from '../../../../../projects/contracts/index.js';
import { AgentsReader } from '../../../agents-reader.js';
import { SkillsReader } from '../../../skills-reader.js';
import {
  MAX_LISTED_SKILLS,
  MAX_READ_BYTES,
  MAX_READ_PATHS,
  ReadSkillsHandler,
} from '../handler.js';

const COMMIT = 'a'.repeat(40);

const VALID = (name: string, extra = '') =>
  `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\nHow to ${name}.\n`;

interface Scripted {
  snapshot?: DefinitionsSnapshot | null;
  tree?: DefinitionsTreeResult;
  files?: Record<string, string>;
  readFiles?: DefinitionsFilesResult;
}

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
    readBlobs: vi.fn(() => Promise.reject(new Error('not used'))),
    blobIds: vi.fn(() => Promise.reject(new Error('not used'))),
  } satisfies DefinitionsFiles;
  const skills = new SkillsReader(fake);
  return { fake, handler: new ReadSkillsHandler(skills, new AgentsReader(fake, skills)) };
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

describe('ReadSkillsHandler', () => {
  it('answers no skill and no commit when no definitions Repository is connected', async () => {
    const { handler, fake } = scripted({ snapshot: null });

    await expect(handler.execute()).resolves.toEqual({
      commit: null,
      repository: null,
      truncated: false,
      skills: [],
      usedBy: [],
    });
    expect(fake.listTree).not.toHaveBeenCalled();
  });

  it('lists a valid skill with its fields, instructions and files', async () => {
    const { handler, fake } = scripted({
      tree: listed(file('skills/review/SKILL.md', 90), file('skills/review/notes.txt', 7)),
      files: { 'skills/review/SKILL.md': VALID('review') },
    });

    const result = await handler.execute();

    expect(result.commit).toBe(COMMIT);
    expect(result.repository).toEqual({ state: 'ready', note: null });
    expect(result.skills).toEqual([
      {
        name: 'review',
        description: 'Does review',
        valid: true,
        problems: [],
        instructions: 'How to review.\n',
        files: [
          { path: 'SKILL.md', size: 90 },
          { path: 'notes.txt', size: 7 },
        ],
      },
    ]);
    expect(fake.listTree).toHaveBeenCalledWith(COMMIT, { directory: 'skills' });
  });

  it('reads the entry file and every Markdown file, and no other file', async () => {
    const { handler, fake } = scripted({
      tree: listed(
        file('skills/a/SKILL.md'),
        file('skills/a/docs/guide.MD'),
        file('skills/a/data.json'),
        file('skills/a/script.sh'),
      ),
      files: { 'skills/a/SKILL.md': VALID('a') },
    });

    await handler.execute();

    expect(fake.readFiles).toHaveBeenCalledWith(
      COMMIT,
      ['skills/a/SKILL.md', 'skills/a/docs/guide.MD'],
      MAX_FILE_BYTES,
    );
  });

  it('lists an invalid skill with its problems and no description', async () => {
    const { handler } = scripted({
      tree: listed(file('skills/bad/SKILL.md', 50), file('skills/bad/extra.md', 20)),
      files: {
        'skills/bad/SKILL.md': VALID('bad', 'hooks: x\n'),
        'skills/bad/extra.md': 'run !`ls` now',
      },
    });

    const [bad] = (await handler.execute()).skills;

    expect(bad).toMatchObject({
      name: 'bad',
      description: null,
      valid: false,
      instructions: '',
      files: [
        { path: 'SKILL.md', size: 50 },
        { path: 'extra.md', size: 20 },
      ],
    });
    expect(bad?.problems.map((problem) => `${problem.code}@${problem.path}`).sort()).toEqual([
      'forbidden_key@SKILL.md',
      'shell_line@extra.md',
    ]);
  });

  it.each([
    ['a folder with no entry file', [file('skills/x/readme.txt')], {}, 'entry_missing'],
    [
      'an entry file with no front matter',
      [file('skills/x/SKILL.md')],
      { 'skills/x/SKILL.md': 'just text' },
      'front_matter_missing',
    ],
    [
      'a name that differs from the folder',
      [file('skills/x/SKILL.md')],
      { 'skills/x/SKILL.md': VALID('y') },
      'name_mismatch',
    ],
    [
      'a hidden file',
      [file('skills/x/SKILL.md'), file('skills/x/.env')],
      { 'skills/x/SKILL.md': VALID('x') },
      'cli_config_path',
    ],
  ])('refuses %s with its reason', async (_label, entries, files, code) => {
    const { handler } = scripted({ tree: listed(...entries), files });

    const [skill] = (await handler.execute()).skills;

    expect(skill?.valid).toBe(false);
    expect(skill?.problems.map((problem) => problem.code)).toContain(code);
  });

  it('judges a folder refused by its declared sizes from the tree alone, with no read', async () => {
    const { handler, fake } = scripted({
      tree: listed(
        file('skills/big/SKILL.md', MAX_FILE_BYTES + 1),
        file('skills/big/notes.md', 5),
        ...Array.from({ length: Math.floor(MAX_FOLDER_BYTES / MAX_FILE_BYTES) + 1 }, (_, index) =>
          file(`skills/total/f${index}.md`, MAX_FILE_BYTES),
        ),
        file('skills/total/SKILL.md', 5),
      ),
    });

    const { skills } = await handler.execute();

    expect(fake.readFiles).not.toHaveBeenCalled();
    expect(skills.map((skill) => skill.problems.map((problem) => problem.code))).toEqual([
      ['file_too_large'],
      ['folder_too_large'],
    ]);
  });

  it('judges a folder with more files than the limit from the tree alone, with exact problems', async () => {
    const entries = Array.from({ length: MAX_FILES + 1 }, (_, index) =>
      file(`skills/many/n${index}.md`),
    );
    const { handler, fake } = scripted({ tree: listed(file('skills/many/SKILL.md'), ...entries) });

    const [skill] = (await handler.execute()).skills;

    expect(skill?.problems.map((problem) => problem.code)).toEqual(['too_many_files']);
    expect(fake.readFiles).not.toHaveBeenCalled();
  });

  describe('the read budget of a list', () => {
    const folderOf = (name: string, files: number, size: number) => [
      file(`skills/${name}/SKILL.md`, size),
      ...Array.from({ length: files - 1 }, (_, index) => file(`skills/${name}/r${index}.md`, size)),
    ];

    it('stops at the last skill read in full within the path budget and says so', async () => {
      const per = 50;
      const count = Math.floor(MAX_READ_PATHS / per) + 2;
      const entries = Array.from({ length: count }, (_, index) =>
        folderOf(`s${String(index).padStart(2, '0')}`, per, 10),
      ).flat();
      const { handler, fake } = scripted({ tree: listed(...entries) });

      const result = await handler.execute();

      const fit = Math.floor(MAX_READ_PATHS / per);
      expect(result.truncated).toBe(true);
      expect(result.skills.map((skill) => skill.name)).toEqual(
        Array.from({ length: fit }, (_, index) => `s${String(index).padStart(2, '0')}`),
      );
      expect(fake.readFiles.mock.calls[0]?.[1]).toHaveLength(fit * per);
      expect(fake.readFiles.mock.calls[0]?.[1].length).toBeLessThanOrEqual(MAX_READ_PATHS);
    });

    it('stops within the byte budget', async () => {
      const size = MAX_FILE_BYTES / 2;
      const per = 5;
      const fit = Math.floor(MAX_READ_BYTES / (size * per));
      const entries = Array.from({ length: fit + 2 }, (_, index) =>
        folderOf(`s${index}`, per, size),
      ).flat();
      const { handler, fake } = scripted({ tree: listed(...entries) });

      const result = await handler.execute();

      expect(result.truncated).toBe(true);
      expect(result.skills).toHaveLength(fit);
      expect(fake.readFiles.mock.calls[0]?.[1]).toHaveLength(fit * per);
    });

    it('reads in name order whatever the order of the tree', async () => {
      const { handler } = scripted({
        tree: listed(file('skills/b/SKILL.md'), file('skills/a/SKILL.md')),
      });

      expect((await handler.execute()).skills.map((skill) => skill.name)).toEqual(['a', 'b']);
    });

    it('still gives the detail of a skill beyond the cut, reading only its folder', async () => {
      const per = 100;
      const count = Math.floor(MAX_READ_PATHS / per) + 2;
      const entries = Array.from({ length: count }, (_, index) =>
        folderOf(`s${index}`, per, 10),
      ).flat();
      const last = `s${count - 1}`;
      const { handler, fake } = scripted({
        tree: listed(...entries),
        files: { [`skills/${last}/SKILL.md`]: VALID(last) },
      });
      await handler.execute();
      fake.readFiles.mockClear();

      const { skills } = await handler.execute({ name: last });

      expect(skills.map((skill) => skill.name)).toEqual([last]);
      expect(fake.readFiles.mock.calls[0]?.[1]).toHaveLength(per);
    });

    it('reads only the folder asked for, with no list read first', async () => {
      const { handler, fake } = scripted({
        tree: listed(...folderOf('a', 5, 10), ...folderOf('b', 5, 10)),
      });

      await handler.execute({ name: 'b' });

      expect(fake.readFiles.mock.calls[0]?.[1]).toHaveLength(5);
      expect(fake.readFiles.mock.calls[0]?.[1].every((path) => path.startsWith('skills/b/'))).toBe(
        true,
      );
    });
  });

  it('keeps a name that needs escaping as text and judges it invalid', async () => {
    const { handler } = scripted({
      tree: listed(file('skills/a b<script>/SKILL.md')),
      files: { 'skills/a b<script>/SKILL.md': VALID('a b<script>') },
    });

    const [skill] = (await handler.execute()).skills;

    expect(skill).toMatchObject({ name: 'a b<script>', valid: false });
    expect(skill?.problems.map((problem) => problem.code)).toContain('name_invalid');
  });

  it('lists at most 200 skill folders and says so', async () => {
    const entries = Array.from({ length: MAX_LISTED_SKILLS + 1 }, (_, index) =>
      file(`skills/s${String(index).padStart(3, '0')}/SKILL.md`),
    );
    const { handler, fake } = scripted({ tree: listed(...entries) });

    const result = await handler.execute();

    expect(MAX_LISTED_SKILLS).toBe(200);
    expect(result.truncated).toBe(true);
    expect(result.skills).toHaveLength(MAX_LISTED_SKILLS);
    expect(fake.readFiles.mock.calls[0]?.[1]).toHaveLength(MAX_LISTED_SKILLS);
  });

  it('does not judge the last folder of a cut listing, which may be partial', async () => {
    const { handler } = scripted({
      tree: {
        status: 'listed',
        entries: [file('skills/a/SKILL.md'), file('skills/b/SKILL.md')],
        truncated: true,
      },
      files: { 'skills/a/SKILL.md': VALID('a') },
    });

    const result = await handler.execute();

    expect(result.truncated).toBe(true);
    expect(result.skills.map((skill) => skill.name)).toEqual(['a']);
  });

  it('reads one skill only, also beyond the first 200', async () => {
    const entries = Array.from({ length: MAX_LISTED_SKILLS + 5 }, (_, index) =>
      file(`skills/s${String(index).padStart(3, '0')}/SKILL.md`),
    );
    const { handler, fake } = scripted({
      tree: listed(...entries),
      files: { 'skills/s204/SKILL.md': VALID('s204') },
    });

    const { skills } = await handler.execute({ name: 's204' });

    expect(skills.map((skill) => skill.name)).toEqual(['s204']);
    expect(fake.readFiles).toHaveBeenLastCalledWith(
      COMMIT,
      ['skills/s204/SKILL.md'],
      MAX_FILE_BYTES,
    );
  });

  it('answers no skill for an unknown name, and ignores agents and other folders', async () => {
    const { handler, fake } = scripted({
      tree: listed(file('agents/a/AGENT.md'), file('docs/x.md'), file('skills/s/SKILL.md')),
      files: { 'skills/s/SKILL.md': VALID('s') },
    });

    await expect(handler.execute({ name: 'a' })).resolves.toMatchObject({ skills: [] });
    expect((await handler.execute()).skills.map((skill) => skill.name)).toEqual(['s']);
    expect(fake.readFiles).toHaveBeenCalledTimes(1);
  });

  it('answers an empty list for a Repository with no skill folder', async () => {
    const { handler } = scripted({ tree: listed(file('agents/a/AGENT.md')) });

    await expect(handler.execute()).resolves.toMatchObject({
      commit: COMMIT,
      truncated: false,
      skills: [],
    });
  });

  describe('a Repository that is not ready', () => {
    it('reads nothing while there is no commit, and says what the Repository waits for', async () => {
      const { handler, fake } = scripted({ snapshot: { state: 'awaiting_key', commit: null } });

      const result = await handler.execute();

      expect(result.commit).toBeNull();
      expect(result.skills).toEqual([]);
      expect(result.repository?.state).toBe('awaiting_key');
      expect(result.repository?.note).toContain('Deploy key');
      expect(fake.listTree).not.toHaveBeenCalled();
    });

    it('shows the last known skills with a note, at the commit the Clone holds', async () => {
      const { handler } = scripted({
        snapshot: { state: 'failed', commit: COMMIT },
        tree: listed(file('skills/s/SKILL.md')),
        files: { 'skills/s/SKILL.md': VALID('s') },
      });

      const result = await handler.execute();

      expect(result.commit).toBe(COMMIT);
      expect(result.repository?.note).toContain('last fetched commit');
      expect(result.skills.map((skill) => skill.name)).toEqual(['s']);
    });

    it.each([
      ['unsupported_platform', 'only on Linux'],
      ['commit_missing', 'does not hold that commit'],
      ['repository_not_ready', 'no Clone'],
      ['failed', 'could not be read'],
    ] as const)('says why a %s Clone is not read', async (status, text) => {
      const { handler } = scripted({ tree: { status } });

      const result = await handler.execute();

      expect(result.commit).toBeNull();
      expect(result.skills).toEqual([]);
      expect(result.repository?.note).toContain(text);
    });

    it('says why when the files cannot be read', async () => {
      const { handler } = scripted({
        tree: listed(file('skills/a/SKILL.md')),
        readFiles: { status: 'failed' },
      });

      const result = await handler.execute();

      expect(result.commit).toBeNull();
      expect(result.repository?.note).toContain('could not be read');
    });
  });

  describe('the memo of judged lists', () => {
    const at = (commit: string) => ({ state: 'ready' as const, commit });
    const one = () =>
      scripted({
        tree: listed(file('skills/a/SKILL.md')),
        files: { 'skills/a/SKILL.md': VALID('a') },
      });

    it('starts no read at a commit it has judged, for the list or for one skill', async () => {
      const { handler, fake } = one();

      const first = await handler.execute();
      const again = await handler.execute();
      const detail = await handler.execute({ name: 'a' });

      expect(again).toEqual(first);
      expect(detail.skills.map((skill) => skill.name)).toEqual(['a']);
      // The detail also reads the agents of the commit, once; the skills only once.
      const calls = fake.listTree.mock.calls as unknown as [string, { directory?: string }?][];
      const skillTrees = calls.filter(([, options]) => options?.directory);
      expect(skillTrees).toHaveLength(1);
    });

    it('reads a new commit afresh', async () => {
      const { handler, fake } = one();
      await handler.execute();
      const next = 'b'.repeat(40);
      fake.snapshot.mockResolvedValueOnce(at(next));

      const second = await handler.execute();

      expect(second.commit).toBe(next);
      expect(fake.listTree).toHaveBeenLastCalledWith(next, { directory: 'skills' });
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
});

describe('ReadSkillsHandler usedBy', () => {
  const agent = (name: string, extra: string) =>
    `---\nname: ${name}\ndescription: d\nprovider: codex\n${extra}---\nx\n`;

  it('names the agents of the commit that list the skill, only for one skill by name', async () => {
    const { handler } = scripted({
      tree: listed(
        file('skills/review/SKILL.md'),
        file('agents/zed/AGENT.md'),
        file('agents/alpha/AGENT.md'),
        file('agents/plain/AGENT.md'),
      ),
      files: {
        'skills/review/SKILL.md': VALID('review'),
        'agents/zed/AGENT.md': agent('zed', 'skills: [review]\n'),
        'agents/alpha/AGENT.md': agent('alpha', 'skills: [review]\ncolour: red\n'),
        'agents/plain/AGENT.md': agent('plain', ''),
      },
    });

    expect((await handler.execute({ name: 'review' })).usedBy).toEqual(['alpha', 'zed']);
    expect((await handler.execute()).usedBy).toEqual([]);
  });
});
