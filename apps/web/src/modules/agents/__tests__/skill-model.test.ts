import {
  MAX_FILE_BYTES,
  validateAgentFolder,
  validateSkillFolder,
} from '@agentic-studio/agent-definitions';
import { describe, expect, it } from 'vitest';
import type { AgentSummaryOutput } from '../../../platform/api';
import { listProblems, newAgentFile } from '../features/agent-editor/draft-model';
import type { EditorEntry } from '../features/agent-editor/editor-model';
import {
  agentsNaming,
  fromDraftSkill,
  namingAgentProblems,
  newSkillFile,
  skillNameError,
  skillOfPath,
  skillStandings,
  unheldMarkdownProblems,
  validateSkillLive,
} from '../features/agent-editor/skill-model';

const entry = (path: string, overrides: Partial<EditorEntry> = {}): EditorEntry => ({
  path,
  kind: 'file',
  size: 20,
  openable: true,
  agent: null,
  skill: skillOfPath(path),
  ...overrides,
});

const SKILL = '---\nname: lint\ndescription: Lints a change\n---\nSteps.\n';
const live = (
  entries: EditorEntry[],
  texts: Record<string, string>,
  sizes: Record<string, number> = {},
) =>
  validateSkillLive(
    'lint',
    entries,
    new Map(Object.entries(texts)),
    new Map(Object.entries(sizes)),
  );

describe('newSkillFile and skillNameError', () => {
  it('makes an entry file that passes the validation', () => {
    const text = newSkillFile('fresh');

    expect(
      validateSkillFolder('fresh', [
        { path: 'SKILL.md', kind: 'file', size: text.length, content: text },
      ]).ok,
    ).toBe(true);
  });

  it.each(['123', 'true', 'null', '1e5', '0x1f', '0o7', 'false'])(
    'makes entry files that pass the validation for the name %s',
    (name) => {
      const skill = newSkillFile(name);
      const agent = newAgentFile(name, 'codex');

      expect(
        validateSkillFolder(name, [
          { path: 'SKILL.md', kind: 'file', size: skill.length, content: skill },
        ]).ok,
      ).toBe(true);
      expect(
        validateAgentFolder(name, [
          { path: 'AGENT.md', kind: 'file', size: agent.length, content: agent },
        ]).ok,
      ).toBe(true);
    },
  );

  it('refuses an empty name, a bad name and a taken one', () => {
    expect(skillNameError('', new Set())).toMatch(/Enter a name/);
    expect(skillNameError('Bad_Name', new Set())).toMatch(/lower-case/);
    expect(skillNameError('lint', new Set(['lint']))).toMatch(/already exists/);
    expect(skillNameError('lint', new Set())).toBeUndefined();
  });
});

describe('validateSkillLive', () => {
  it('has no problem for a valid skill', () => {
    expect(live([entry('skills/lint/SKILL.md')], { 'skills/lint/SKILL.md': SKILL })).toEqual([]);
  });

  it('flags a forbidden key and a shell line, each at its file', () => {
    const entries = [entry('skills/lint/SKILL.md'), entry('skills/lint/notes.md')];

    const problems = live(entries, {
      'skills/lint/SKILL.md': SKILL.replace('---\nSteps', 'tools: Bash\n---\nSteps'),
      'skills/lint/notes.md': '!`rm -rf /`\n',
    });

    expect(problems?.map((p) => [p.skill, p.code, p.target.path]).sort()).toEqual([
      ['lint', 'forbidden_key', 'skills/lint/SKILL.md'],
      ['lint', 'shell_line', 'skills/lint/notes.md'],
    ]);
  });

  it('gives no answer while the entry file’s text is not known', () => {
    expect(live([entry('skills/lint/SKILL.md')], {})).toBeUndefined();
  });

  it('does not call a Markdown file unreadable when its text is only not known here', () => {
    const entries = [entry('skills/lint/SKILL.md'), entry('skills/lint/notes.md')];

    expect(live(entries, { 'skills/lint/SKILL.md': SKILL })).toEqual([]);
  });

  it('drops "cannot be read" for a folder its declared sizes already refuse, as the API does', () => {
    const big = entry('skills/lint/big.bin', { size: MAX_FILE_BYTES + 1 });
    const entries = [entry('skills/lint/SKILL.md'), big];

    const problems = live(entries, {});

    expect(problems?.map((p) => p.code)).toEqual(['file_too_large']);
  });

  it('flags a deleted entry file and ignores deleted files', () => {
    const entries = [
      entry('skills/lint/SKILL.md', { change: 'deleted' }),
      entry('skills/lint/notes.md'),
    ];

    expect(live(entries, {})?.map((p) => [p.code, p.target.path])).toEqual([
      ['entry_missing', 'skills/lint/SKILL.md'],
    ]);
  });
});

const agent = (name: string, skills: string[], extra: Partial<AgentSummaryOutput> = {}) =>
  ({
    name,
    description: null,
    provider: null,
    model: null,
    source: 'definitions',
    usable: true,
    problems: [],
    skills,
    ...extra,
  }) as AgentSummaryOutput;

describe('the agents a skill touches', () => {
  it('leaves out an agent whose entry file the Draft deletes or moves away', () => {
    const entries = [
      entry('agents/gone/AGENT.md', { agent: 'gone', change: 'deleted' }),
      entry('agents/old/AGENT.md', { agent: 'old', change: 'deleted' }),
      entry('agents/new/AGENT.md', { agent: 'new', change: 'added' }),
    ];
    const base = [agent('gone', ['lint']), agent('old', ['lint'])];
    const texts = new Map([['agents/new/AGENT.md', '---\nname: new\nskills:\n  - lint\n---\n']]);

    expect(agentsNaming('lint', base, entries, texts)).toEqual(['new']);
  });

  it('finds the agents that name a skill, from the base and from the Draft’s own entry files', () => {
    const entries = [
      entry('agents/a/AGENT.md', { agent: 'a' }),
      entry('agents/b/AGENT.md', { agent: 'b', change: 'modified' }),
      entry('agents/c/AGENT.md', { agent: 'c', change: 'modified' }),
    ];
    const base = [agent('a', ['lint']), agent('b', ['lint']), agent('c', [])];
    // b no longer names it in the Draft; c now does.
    const texts = new Map([
      ['agents/b/AGENT.md', '---\nname: b\nskills:\n  - other\n---\n'],
      ['agents/c/AGENT.md', '---\nname: c\nskills:\n  - lint\n---\n'],
    ]);

    expect(agentsNaming('lint', base, entries, texts)).toEqual(['a', 'c']);
  });

  it('judges the untouched agents that name a skill against the skill as it stands now', () => {
    const entries = [entry('skills/lint/SKILL.md')];
    const invalid = skillStandings(entries, [], new Set(['lint']), new Set(['lint']));
    const problems = namingAgentProblems(
      'lint',
      [agent('a', ['lint']), agent('touched', ['lint']), agent('other', ['x'])],
      new Set(['touched']),
      invalid,
    );

    expect([...problems.keys()]).toEqual(['a']);
    expect(problems.get('a')?.map((p) => [p.code, p.target.path])).toEqual([
      ['skill_invalid', 'agents/a/AGENT.md'],
    ]);
  });
});

describe('unheldMarkdownProblems', () => {
  const problem = (path: string, code = 'shell_line') =>
    ({ agent: null, skill: 'lint', code, message: code, target: { path } }) as const;

  it('keeps the problems of other Markdown files and not those of the entry file', () => {
    const kept = unheldMarkdownProblems(
      [
        problem('skills/lint/notes.md'),
        problem('skills/lint/SKILL.md', 'entry_missing'),
        problem('skills/lint/SKILL.md', 'file_too_large'),
        problem('skills/lint/big.bin', 'file_too_large'),
      ],
      new Map(),
      'skills/lint/SKILL.md',
    );

    expect(kept.map((p) => p.target.path)).toEqual(['skills/lint/notes.md']);
  });

  it('leaves out a Markdown file whose text the browser holds', () => {
    const kept = unheldMarkdownProblems(
      [problem('skills/lint/notes.md')],
      new Map([['skills/lint/notes.md', 'text']]),
      'skills/lint/SKILL.md',
    );

    expect(kept).toEqual([]);
  });
});

describe('fromDraftSkill', () => {
  it('sends a folder-level problem to the entry file, as the other sources do', () => {
    const listed = fromDraftSkill({
      skill: 'lint',
      code: 'too_many_files',
      path: 'skills/lint',
      key: null,
      message: 'Too many files.',
    });

    expect(listed.target.path).toBe('skills/lint/SKILL.md');
  });
});

describe('skillStandings', () => {
  it('gives no verdict on a skill the list does not hold when the list was cut', () => {
    const entries = [entry('skills/unlisted/SKILL.md')];

    expect(skillStandings(entries, [], new Set(), new Set(), true).get('unlisted')).toEqual({
      valid: true,
    });
    expect(skillStandings(entries, [], new Set(), new Set(), false).get('unlisted')).toEqual({
      valid: false,
    });
  });

  it('takes untouched skills from the list and touched ones from their problems', () => {
    const entries = [
      entry('skills/a/SKILL.md'),
      entry('skills/b/SKILL.md'),
      entry('skills/c/SKILL.md', { change: 'deleted' }),
    ];
    const base = [
      { name: 'a', valid: true, description: null, problems: [] },
      { name: 'b', valid: false, description: null, problems: [] },
    ];

    const standings = skillStandings(entries, base, new Set(), new Set(['b']));

    expect(standings.get('a')).toEqual({ valid: true });
    expect(standings.get('b')).toEqual({ valid: true });
    expect(standings.has('c')).toBe(false);
  });
});

describe('listProblems for skills', () => {
  it('replaces the base problems of what the Draft judges and keeps the rest', () => {
    const base = [
      agent('a', ['lint'], {
        usable: false,
        problems: [{ code: 'skill_invalid', path: 'AGENT.md', key: 'lint', message: 'old' }],
      }),
      agent('kept', [], {
        usable: false,
        problems: [{ code: 'key_missing', path: 'AGENT.md', key: 'name', message: 'kept' }],
      }),
    ];

    const listed = listProblems({
      base,
      baseSkills: [
        {
          name: 'lint',
          valid: false,
          description: null,
          problems: [{ code: 'shell_line', path: 'SKILL.md', key: null, message: 'old skill' }],
        },
        {
          name: 'other',
          valid: false,
          description: null,
          problems: [{ code: 'shell_line', path: 'SKILL.md', key: null, message: 'other skill' }],
        },
      ],
      draft: [],
      draftSkills: [],
      touched: new Set(),
      touchedSkills: new Set(['lint']),
      named: new Set(['a']),
    });

    expect(listed.map((p) => p.message)).toEqual(['kept', 'other skill']);
  });
});
