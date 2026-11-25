import { previewBuildSchema } from '@agentic-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { RequestPreviewBuildHandler } from '../../../../../application/features/request-preview-build/handler.js';
import { PreviewSettingsMissingError } from '../../../../../domain/errors/preview-operation-errors.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewLimitReachedError,
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { RequestPreviewBuildEndpoint } from '../endpoint.js';

const ID = '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10';

function endpoint(execute: () => Promise<unknown>) {
  return new RequestPreviewBuildEndpoint({ execute } as unknown as RequestPreviewBuildHandler);
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
          startedBy: { kind: 'operator' as const },
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
    expect(execute).toHaveBeenCalledWith({ projectId: 'project' });
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
      'a stop or a reset under way',
      new PreviewBusyError(),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.previewBusy,
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

  it('maps the limit to 409 with the Projects that hold the places, by name', async () => {
    const A = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
    const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const error = new PreviewLimitReachedError(
      2,
      [
        { projectId: A, state: 'running' },
        { projectId: B, state: 'building' },
      ],
      new Map([[A, 'Shop']]),
    );

    const problem = await problemOf(error);

    expect(problem.getStatus()).toBe(409);
    expect(problem.problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.previewLimitReached);
    expect(problem.problem.detail).toBe(
      `At most 2 Previews run at the same time. Running now: Shop, ${B}. Stop one first.`,
    );
    expect(problem.problem.extensions).toEqual({
      running: [
        { projectId: A, name: 'Shop', state: 'running' },
        { projectId: B, name: B, state: 'building' },
      ],
    });
  });

  it('maps a refused file to 422 with every refusal', async () => {
    const refusals = [{ code: 'privileged', place: 'services.web.privileged', message: 'No.' }];

    const problem = await problemOf(new PreviewRefusedError(refusals));

    expect(problem.getStatus()).toBe(422);
    expect(problem.problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.previewRefused);
    expect(problem.problem.extensions).toEqual({ refusals });
  });
});
