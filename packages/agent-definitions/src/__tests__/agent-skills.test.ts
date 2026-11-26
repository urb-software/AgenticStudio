import { describe, expect, it } from 'vitest';
import {
  AGENT_SKILL_CHECK_CODES,
  agentSkillNames,
  checkAgentSkills,
  MAX_AGENT_SKILLS,
  PROBLEM_CODES,
  validateAgentFolder,
  type AgentDefinition,
} from '../index.js';
import { entryFile, VALID_FRONT } from './fixtures.js';

const agentWith = (extra: string): AgentDefinition => {
  const result = validateAgentFolder('reviewer', [entryFile(`${VALID_FRONT}\n${extra}`)]);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.definition;
};

const summary = (problems: { code: string; key?: string }[]) =>
  problems.map((item) => `${item.code}:${item.key ?? ''}`);

describe('the skills key of an agent', () => {
  it('is optional: without it the agent names no skill', () => {
    const result = validateAgentFolder('reviewer', [entryFile(VALID_FRONT)]);
    if (!result.ok) throw new Error('refused');
    expect(result.definition.skills).toEqual([]);
  });

  it('keeps the names in the order written; an empty list or null is no skill', () => {
    expect(agentWith('skills: [b, a]').skills).toEqual(['b', 'a']);
    expect(agentWith('skills:\n  - one\n  - two').skills).toEqual(['one', 'two']);
    expect(agentWith('skills: []').skills).toEqual([]);
    expect(agentWith('skills:').skills).toEqual([]);
  });

  it('accepts exactly the limit', () => {
    const names = Array.from({ length: MAX_AGENT_SKILLS }, (_, index) => `s${index}`);
    expect(agentWith(`skills: [${names.join(',')}]`).skills).toHaveLength(MAX_AGENT_SKILLS);
    expect(MAX_AGENT_SKILLS).toBe(20);
  });

  it('quotes only the shortened name, never more', () => {
    const long = `A${'x'.repeat(100)}`;
    const result = validateAgentFolder('reviewer', [
      entryFile(`${VALID_FRONT}\nskills: [${long}]`),
    ]);
    if (result.ok) throw new Error('accepted');
    const [item] = result.problems;
    expect(item?.code).toBe('skill_name_invalid');
    expect(item?.key).toBe(long.slice(0, 64));
    expect(item?.message).toContain(`${long.slice(0, 64)}...`);
    expect(item?.message).not.toContain(long);
  });

  it('reports a name listed twice once, and judges names exactly (case variants are invalid)', () => {
    const result = validateAgentFolder('reviewer', [
      entryFile(`${VALID_FRONT}\nskills: [a, a, a, Helper]`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(summary(result.problems)).toEqual(['skill_listed_twice:a', 'skill_name_invalid:Helper']);
  });

  it('does not report every name of a list far over the limit', () => {
    const names = Array.from({ length: 300 }, (_, index) => `S${index}`);
    const result = validateAgentFolder('reviewer', [
      entryFile(`${VALID_FRONT}\nskills: [${names.join(',')}]`),
    ]);
    if (result.ok) throw new Error('accepted');
    expect(result.problems.length).toBeLessThanOrEqual(MAX_AGENT_SKILLS + 1);
    expect(result.problems.map((item) => item.code)).toContain('too_many_skills');
  });
});

describe('agentSkillNames', () => {
  const text = (front: string) => `---\n${VALID_FRONT}\n${front}\n---\nx`;

  it('reads the listed names even when the agent is invalid for another reason', () => {
    expect(agentSkillNames(text('skills: [a, b]\ncolour: red'))).toEqual(['a', 'b']);
  });

  it('is empty without a list of text, or for a front matter that cannot be read', () => {
    expect(agentSkillNames(text(''))).toEqual([]);
    expect(agentSkillNames(text('skills: a'))).toEqual([]);
    expect(agentSkillNames(text('skills: [a, 5]'))).toEqual([]);
    expect(agentSkillNames('no front matter')).toEqual([]);
    expect(agentSkillNames('---\nname: [x\n---\n')).toEqual([]);
  });
});

describe('checkAgentSkills', () => {
  const agent = agentWith('skills: [good, bad, gone]');
  const skills = new Map([
    ['good', { valid: true }],
    ['bad', { valid: false }],
  ]);

  it('reports a missing skill and an invalid one, each with the skill name', () => {
    const problems = checkAgentSkills(agent, skills);
    expect(summary(problems)).toEqual(['skill_invalid:bad', 'skill_missing:gone']);
    expect(problems.every((item) => item.path === 'AGENT.md')).toBe(true);
    expect(problems.map((item) => item.message)).toEqual([
      'The skill "bad" is not valid.',
      'The skill "gone" does not exist.',
    ]);
  });

  it('finds nothing for an agent without skills, whatever the skills are', () => {
    expect(checkAgentSkills(agentWith(''), new Map())).toEqual([]);
    expect(checkAgentSkills(agentWith('skills: [good]'), skills)).toEqual([]);
  });

  it('compares names exactly', () => {
    const problems = checkAgentSkills(
      agentWith('skills: [good]'),
      new Map([['Good', { valid: true }]]),
    );
    expect(summary(problems)).toEqual(['skill_missing:good']);
  });

  it('has a code for each reason, both in PROBLEM_CODES', () => {
    expect([...AGENT_SKILL_CHECK_CODES].sort()).toEqual(['skill_invalid', 'skill_missing']);
    for (const code of AGENT_SKILL_CHECK_CODES) expect(PROBLEM_CODES).toContain(code);
  });
});
