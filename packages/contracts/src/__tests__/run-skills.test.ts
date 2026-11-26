import { describe, expect, it } from 'vitest';
import {
  reportRunStateRequestSchema,
  RUN_FAILURE_CODES,
  RUN_SKILLS_MAX,
  RUN_SKILLS_MAX_BYTES,
  runSkillsQuerySchema,
  runSkillsResponseSchema,
  WORKER_PROBLEM_TYPES,
} from '../index.js';

const COMMIT = 'a'.repeat(40);
const WORKER = '0b0f3a8e-3c1e-4d7a-8f5a-0c6c3f2d9a10';
const file = { path: 'SKILL.md', executable: false, contentBase64: 'IyBTa2lsbAo=' };
const skill = { name: 'release-notes', files: [file] };

describe('the skills hand-over', () => {
  it('answers a commit, the skills with their files and the names left out', () => {
    const parse = (value: unknown) => runSkillsResponseSchema.safeParse(value).success;
    expect(parse({ commit: COMMIT, skills: [skill], omitted: [] })).toBe(true);
    expect(parse({ commit: COMMIT, skills: [], omitted: ['big'] })).toBe(true);
    expect(parse({ commit: null, skills: [], omitted: [] })).toBe(true);
  });

  it('refuses skills without a commit, a bad name, a bad file and extra keys', () => {
    const parse = (value: unknown) => runSkillsResponseSchema.safeParse(value).success;
    expect(parse({ commit: null, skills: [skill], omitted: [] })).toBe(false);
    expect(parse({ commit: 'main', skills: [], omitted: [] })).toBe(false);
    expect(parse({ commit: COMMIT, skills: [{ ...skill, name: '../x' }], omitted: [] })).toBe(
      false,
    );
    expect(
      parse({ commit: COMMIT, skills: [{ ...skill, files: [{ ...file, mode: 1 }] }], omitted: [] }),
    ).toBe(false);
    expect(
      parse({
        commit: COMMIT,
        skills: [{ ...skill, files: [{ ...file, contentBase64: '!' }] }],
        omitted: [],
      }),
    ).toBe(false);
    expect(parse({ commit: COMMIT, skills: [], omitted: [], extra: 1 })).toBe(false);
  });

  it('bounds the number of skills', () => {
    const many = Array.from({ length: RUN_SKILLS_MAX + 1 }, (_, i) => ({
      ...skill,
      name: `s${i}`,
    }));
    expect(
      runSkillsResponseSchema.safeParse({ commit: COMMIT, skills: many, omitted: [] }).success,
    ).toBe(false);
    expect(RUN_SKILLS_MAX).toBe(20);
    expect(RUN_SKILLS_MAX_BYTES).toBe(20 * 1024 * 1024);
  });

  it('is asked with the worker id only', () => {
    expect(runSkillsQuerySchema.safeParse({ workerId: WORKER }).success).toBe(true);
    expect(runSkillsQuerySchema.safeParse({ workerId: WORKER, skill: 'x' }).success).toBe(false);
    expect(runSkillsQuerySchema.safeParse({ workerId: WORKER, commit: COMMIT }).success).toBe(
      false,
    );
  });

  it('has a failure code the worker may report, and the problem types it acts on', () => {
    expect(RUN_FAILURE_CODES).toContain('skills_unusable');
    expect(
      reportRunStateRequestSchema.safeParse({
        workerId: WORKER,
        state: 'failed',
        failure: { code: 'skills_unusable', detail: 'x' },
      }).success,
    ).toBe(true);
    expect(WORKER_PROBLEM_TYPES.skillsUnavailable).toBe(
      'urn:agentic-studio:problem:skills-unavailable',
    );
    expect(WORKER_PROBLEM_TYPES.skillsInvalid).toBe('urn:agentic-studio:problem:skills-invalid');
  });
});
