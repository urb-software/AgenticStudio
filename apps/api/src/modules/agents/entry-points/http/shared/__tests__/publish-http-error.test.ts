import { describe, expect, it } from 'vitest';
import {
  FieldProblemException,
  ProblemException,
} from '../../../../../../platform/http/problem-details.js';
import { DraftChangedConcurrentlyError } from '../../../../domain/errors/agent-draft-errors.js';
import {
  NothingToPublishError,
  PublishFailedError,
  PublishNotConfiguredError,
  PublishPathOutsideDefinitionsError,
  PublishProblemsError,
  PublishRunningError,
  RepositoryMovedError,
  WriteRefusedError,
} from '../../../../domain/errors/agent-publish-errors.js';
import { InvalidPublishMessageError } from '../../../../domain/value-objects/publish-message.js';
import { AGENTS_PROBLEM_TYPES } from '../problems.js';
import { toPublishHttpError } from '../publish-http-error.js';

function problemOf(error: unknown) {
  expect(error).toBeInstanceOf(ProblemException);
  const exception = error as ProblemException;
  return { status: exception.getStatus(), ...exception.problem };
}

describe('toPublishHttpError', () => {
  it.each([
    [new PublishNotConfiguredError(), 503, AGENTS_PROBLEM_TYPES.publishNotConfigured],
    [new PublishRunningError(), 409, AGENTS_PROBLEM_TYPES.publishRunning],
    [new NothingToPublishError(), 409, AGENTS_PROBLEM_TYPES.nothingToPublish],
    [new RepositoryMovedError(), 409, AGENTS_PROBLEM_TYPES.repositoryMoved],
    [new WriteRefusedError(), 409, AGENTS_PROBLEM_TYPES.writeRefused],
    [
      new PublishPathOutsideDefinitionsError(['.github/ci.yml']),
      422,
      AGENTS_PROBLEM_TYPES.publishPathOutsideDefinitions,
    ],
    [new PublishFailedError('failed'), 502, AGENTS_PROBLEM_TYPES.publishFailed],
    [
      new PublishFailedError('repository_not_ready'),
      503,
      AGENTS_PROBLEM_TYPES.agentFilesUnreadable,
    ],
    [
      new PublishFailedError('unsupported_platform'),
      503,
      AGENTS_PROBLEM_TYPES.agentFilesUnreadable,
    ],
    [new DraftChangedConcurrentlyError(), 409, AGENTS_PROBLEM_TYPES.draftConflict],
  ])('maps %s to %i %s, each refusal with its own reason', (error, status, type) => {
    expect(problemOf(toPublishHttpError(error))).toMatchObject({ status, type });
  });

  it('tells the Operator what to change on the Git host when the write is refused', () => {
    const { detail } = problemOf(toPublishHttpError(new WriteRefusedError()));

    expect(detail).toMatch(/Deploy key/);
    expect(detail).toMatch(/write access/i);
  });

  it('lists the paths outside agents/ and skills/ in the answer', () => {
    const problem = problemOf(
      toPublishHttpError(new PublishPathOutsideDefinitionsError(['.github/ci.yml', 'README.md'])),
    );

    expect(problem.extensions).toEqual({ paths: ['.github/ci.yml', 'README.md'] });
  });

  it('lists every problem of the Draft in a 422', () => {
    const problems = [
      {
        agent: 'a',
        code: 'key_missing' as const,
        path: 'agents/a/AGENT.md',
        key: 'description',
        message: 'Add a description.',
      },
    ];

    const problem = problemOf(toPublishHttpError(new PublishProblemsError(problems)));

    expect(problem).toMatchObject({ status: 422, type: AGENTS_PROBLEM_TYPES.publishProblems });
    expect(problem.extensions).toEqual({ problems, skillProblems: [] });
  });

  it('lists the problems of the skills beside those of the agents', () => {
    const skillProblems = [
      {
        skill: 'lint',
        code: 'forbidden_key' as const,
        path: 'skills/lint/SKILL.md',
        key: 'tools',
        message: 'The key "tools" is not allowed.',
      },
    ];

    const problem = problemOf(toPublishHttpError(new PublishProblemsError([], skillProblems)));

    expect(problem).toMatchObject({ status: 422, type: AGENTS_PROBLEM_TYPES.publishProblems });
    expect(problem.extensions).toEqual({ problems: [], skillProblems });
  });

  it('answers a bad message as a field error on the message', () => {
    const error = toPublishHttpError(new InvalidPublishMessageError('Enter a message.'));

    expect(error).toBeInstanceOf(FieldProblemException);
    expect((error as FieldProblemException).getStatus()).toBe(400);
    expect((error as FieldProblemException).problem.errors).toEqual([
      { path: 'message', message: 'Enter a message.' },
    ]);
  });

  it('carries no text of Git, of the host or of a key in any answer', () => {
    for (const error of [
      new WriteRefusedError(),
      new RepositoryMovedError(),
      new PublishFailedError('failed'),
    ]) {
      const { detail, title } = problemOf(toPublishHttpError(error));
      expect(`${title} ${detail}`).not.toMatch(/ssh|PRIVATE|remote:|stderr|fatal|\//i);
    }
  });

  it('returns anything else as it is', () => {
    const other = new Error('boom');

    expect(toPublishHttpError(other)).toBe(other);
  });
});
