import { previewBuildSchema } from '@agentic-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { RequestPreviewOperationHandler } from '../../../../../application/features/request-preview-operation/handler.js';
import { PreviewSettingsMissingError } from '../../../../../domain/errors/preview-operation-errors.js';
import {
  PreviewBuildRunningError,
  PreviewControllerUnavailableError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { RequestPreviewBuildEndpoint } from '../endpoint.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';

function endpoint(execute: () => Promise<unknown>) {
  return new RequestPreviewBuildEndpoint({ execute } as unknown as RequestPreviewOperationHandler);
}

async function problemOf(error: Error): Promise<ProblemException> {
  const caught = await endpoint(() => Promise.reject(error))
    .request('project')
    .catch((reason: unknown) => reason);
  expect(caught).toBeInstanceOf(ProblemException);
  return caught as ProblemException;
}

describe('RequestPreviewBuildEndpoint', () => {
  it('answers the queued build in the contract shape, with ISO times', async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        operationId: ID,
        build: {
          id: ID,
          commit: 'a'.repeat(40),
          status: 'queued' as const,
          requestedAt: new Date('2026-11-24T10:00:00.000Z'),
          startedAt: null,
          finishedAt: null,
          timeLimitMinutes: 20,
          failure: null,
          log: { bytes: 0, truncated: false },
        },
      }),
    );

    const answer = await endpoint(execute).request('project');

    expect(previewBuildSchema.safeParse(answer).success).toBe(true);
    expect(answer.requestedAt).toBe('2026-11-24T10:00:00.000Z');
    expect(execute).toHaveBeenCalledWith({ projectId: 'project', kind: 'build' });
  });

  it.each([
    [
      'an unknown project',
      new ProjectNotFoundError(),
      404,
      ENVIRONMENTS_PROBLEM_TYPES.projectNotFound,
    ],
    [
      'missing settings',
      new PreviewSettingsMissingError(),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.previewNotConfigured,
    ],
    [
      'a Repository that is not ready',
      new PreviewRepositoryNotReadyError('repository_not_ready'),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady,
    ],
    [
      'a platform that is not Linux',
      new PreviewRepositoryNotReadyError('unsupported_platform'),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.unsupportedPlatform,
    ],
    [
      'no controller',
      new PreviewControllerUnavailableError(),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.controllerUnavailable,
    ],
    [
      'a build under way',
      new PreviewBuildRunningError(),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.buildRunning,
    ],
    [
      'an unreadable file',
      new PreviewSourceUnavailableError(),
      502,
      ENVIRONMENTS_PROBLEM_TYPES.sourceUnavailable,
    ],
  ] as const)('maps %s', async (_name, error, status, type) => {
    const problem = await problemOf(error);

    expect(problem.getStatus()).toBe(status);
    expect(problem.problem.type).toBe(type);
  });

  it('maps a refused file to 422 with every refusal', async () => {
    const refusals = [{ code: 'privileged', place: 'services.web.privileged', message: 'No.' }];

    const problem = await problemOf(new PreviewRefusedError(refusals));

    expect(problem.getStatus()).toBe(422);
    expect(problem.problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.previewRefused);
    expect(problem.problem.extensions).toEqual({ refusals });
  });
});
