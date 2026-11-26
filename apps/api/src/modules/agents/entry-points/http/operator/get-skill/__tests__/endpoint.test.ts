import { describe, expect, it, vi } from 'vitest';
import type { ReadSkillsHandler } from '../../../../../application/features/read-skills/handler.js';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import { AGENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { GetSkillEndpoint } from '../endpoint.js';
import { skillDetailResponseSchema } from '../schema.js';

const COMMIT = 'a'.repeat(40);
const repository = { state: 'ready' as const, note: null };

const skill = {
  name: 'review',
  description: 'Reviews',
  valid: true,
  problems: [],
  instructions: '<b>Body</b> [x](http://e)',
  files: [
    { path: 'SKILL.md', size: 30 },
    { path: 'docs/a.md', size: 2 },
  ],
};

const endpointFor = (skills: unknown[], usedBy: string[] = []) => {
  const execute = vi.fn(() =>
    Promise.resolve({ commit: COMMIT, repository, truncated: false, skills, usedBy }),
  );
  return { execute, endpoint: new GetSkillEndpoint({ execute } as unknown as ReadSkillsHandler) };
};

const notFound = async (promise: Promise<unknown>) => {
  const error = (await promise.catch((caught: unknown) => caught)) as ProblemException;
  expect(error).toBeInstanceOf(ProblemException);
  expect(error.getStatus()).toBe(404);
  expect(error.problem.type).toBe(AGENTS_PROBLEM_TYPES.skillNotFound);
};

describe('GetSkillEndpoint', () => {
  it('answers one skill with its instructions as plain text and its files', async () => {
    const { endpoint, execute } = endpointFor([skill], ['alpha', 'zed']);

    const answer = await endpoint.get('review');

    expect(skillDetailResponseSchema.parse(answer)).toEqual(answer);
    expect(answer).toEqual({
      commit: COMMIT,
      repository,
      name: 'review',
      description: 'Reviews',
      valid: true,
      problems: [],
      instructions: '<b>Body</b> [x](http://e)',
      files: skill.files,
      usedBy: ['alpha', 'zed'],
    });
    expect(execute).toHaveBeenCalledWith({ name: 'review' });
  });

  it('answers the problems of an invalid skill', async () => {
    const { endpoint } = endpointFor([
      {
        ...skill,
        description: null,
        valid: false,
        instructions: '',
        problems: [{ code: 'entry_missing', path: '', message: 'No entry file.' }],
      },
    ]);

    await expect(endpoint.get('review')).resolves.toMatchObject({
      valid: false,
      description: null,
      problems: [{ code: 'entry_missing', path: '', key: null, message: 'No entry file.' }],
    });
  });

  it('answers 404 for an unknown name', async () => {
    const { endpoint } = endpointFor([]);

    await notFound(endpoint.get('nope'));
  });

  it.each(['A', 'a b', '../x', 'a/b', '%2e%2e', '<script>', '-a', 'a'.repeat(65), ''])(
    'answers 404 for the name %j without looking it up',
    async (name) => {
      const { endpoint, execute } = endpointFor([skill]);

      await notFound(endpoint.get(name));
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
