import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_KEYS,
  PROBLEM_CODES,
  SKILL_PROBLEM_CODES,
  SHELL_LINE,
  SKILL_ENTRY_FILE,
  SKILL_FORBIDDEN_KEYS,
  SKILL_KNOWN_KEYS,
  SKILLS_DIRECTORY,
  validateSkillFolder,
} from '../index.js';
import { file } from './fixtures.js';
import { SKILL_FAILING, SKILL_FRONT, SKILL_PASSING, skillFile } from './skill-fixtures.js';

const summary = (problems: { code: string; path: string }[]) =>
  problems.map((problem) => `${problem.code}@${problem.path}`).sort();

// Codes that only an agent folder can reach.
const AGENT_ONLY = ['provider_unknown', 'model_unknown', 'name_reserved'];

describe('failing skill fixtures', () => {
  it.each(Object.entries(SKILL_FAILING))('refuses: %s', (_name, fixture) => {
    const result = validateSkillFolder(fixture.folder, fixture.entries);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(summary(result.problems)).toEqual([...fixture.expected].sort());
  });

  it('has a fixture for every code a skill can reach', () => {
    const covered = new Set(
      Object.values(SKILL_FAILING).flatMap((fixture) =>
        fixture.expected.map((item) => item.split('@')[0]),
      ),
    );
    const reachable = SKILL_PROBLEM_CODES.filter((code) => !AGENT_ONLY.includes(code));
    expect(reachable.filter((code) => !covered.has(code))).toEqual([]);
    expect(SKILL_PROBLEM_CODES).toContain('shell_line');
    expect(PROBLEM_CODES).not.toContain('shell_line');
  });

  it('never says "agent" or AGENT.md in a message about a skill', () => {
    const messages = Object.values(SKILL_FAILING).flatMap((fixture) => {
      const result = validateSkillFolder(fixture.folder, fixture.entries);
      return result.ok ? [] : result.problems.map((item) => item.message);
    });
    expect(messages.length).toBeGreaterThan(40);
    // What a message quotes (a path or key) may say it; the wording may not.
    const wording = messages.map((message) => message.replace(/"[^"]*"/g, ''));
    expect(wording.filter((message) => /agent/i.test(message))).toEqual([]);
  });

  it('quotes at most a key or a path, never a value', () => {
    const result = validateSkillFolder('helper', [
      skillFile(`${SKILL_FRONT}\ncolour: secret-value-123\nlicense: ${'z'.repeat(600)}`),
    ]);
    if (result.ok) throw new Error('accepted');
    for (const item of result.problems) {
      expect(item.message).not.toContain('secret-value-123');
      expect(item.message).not.toContain('zzzz');
    }
    expect(result.problems.map((item) => [item.code, item.key])).toEqual([
      ['unknown_key', 'colour'],
      ['key_invalid', 'license'],
    ]);
  });
});

describe('passing skill fixtures', () => {
  it.each(Object.entries(SKILL_PASSING))('accepts a skill with %s', (_name, fixture) => {
    const result = validateSkillFolder(fixture.folder, fixture.entries);
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    expect(result.definition).toMatchObject(fixture.definition);
    expect(result.definition.files.map((item) => item.path)).toEqual(
      fixture.entries.filter((item) => item.kind === 'file').map((item) => item.path),
    );
  });

  it('accepts CRLF line endings and the longest description', () => {
    const crlf = file(
      'SKILL.md',
      `---\r\n${SKILL_FRONT.replaceAll('\n', '\r\n')}\r\n---\r\nBody\r\n`,
    );
    expect(validateSkillFolder('helper', [crlf]).ok).toBe(true);
    const longest = skillFile(`name: helper\ndescription: ${'d'.repeat(500)}`);
    expect(validateSkillFolder('helper', [longest]).ok).toBe(true);
  });

  it('omits the descriptive keys a skill does not set', () => {
    const result = validateSkillFolder('helper', [skillFile(SKILL_FRONT)]);
    if (!result.ok) throw new Error('refused');
    expect(Object.keys(result.definition).sort()).toEqual([
      'description',
      'files',
      'instructions',
      'name',
    ]);
  });
});

describe('the key lists', () => {
  it('accepts exactly these keys', () => {
    expect([...SKILL_KNOWN_KEYS].sort()).toEqual(
      ['compatibility', 'description', 'license', 'metadata', 'name'].sort(),
    );
  });

  it('forbids what agents forbid, and the keys that ask for a fork', () => {
    expect([...SKILL_FORBIDDEN_KEYS].sort()).toEqual(['agent', 'context']);
    expect(FORBIDDEN_KEYS).not.toContain('context');
  });

  it.each([...FORBIDDEN_KEYS, 'ALLOWED_TOOLS', 'Permission-Mode', ...SKILL_FORBIDDEN_KEYS])(
    '%s is forbidden for a skill, not unknown',
    (key) => {
      const result = validateSkillFolder('helper', [skillFile(`${SKILL_FRONT}\n${key}: x`)]);
      if (result.ok) throw new Error('accepted');
      expect(result.problems.map((item) => item.code)).toEqual(['forbidden_key']);
    },
  );

  it('names the folder and entry file', () => {
    expect(SKILLS_DIRECTORY).toBe('skills');
    expect(SKILL_ENTRY_FILE).toBe('SKILL.md');
  });
});

describe('SHELL_LINE', () => {
  it.each([
    ['inline backtick', 'run !`ls` now'],
    ['backtick fence', 'text\n```!\nls\n```'],
    ['tilde fence', 'text\n~~~!\nls\n~~~'],
    ['backtick dollar fence', '```$\nls\n```'],
    ['tilde dollar fence', '~~~$\nls\n~~~'],
    ['bang dollar', 'run !$HOME'],
  ])('matches the %s form', (_name, text) => {
    expect(SHELL_LINE.test(text)).toBe(true);
  });

  it.each(['plain text', 'a ```js\ncode\n``` fence', 'Wow! `code` here', 'cost $5!', '!important'])(
    'does not match %j',
    (text) => {
      expect(SHELL_LINE.test(text)).toBe(false);
    },
  );
});
