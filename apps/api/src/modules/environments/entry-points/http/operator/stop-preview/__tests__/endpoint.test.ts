import { previewSchema } from '@agentic-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { GetPreviewHandler } from '../../../../../application/features/get-preview/handler.js';
import type { RequestPreviewStopHandler } from '../../../../../application/features/request-preview-stop/handler.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  PreviewNotRunningError,
  ProjectNotFoundError,
} from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { StopPreviewEndpoint } from '../endpoint.js';

const VIEW = {
  settings: null,
  hostname: null,
  hostnameUnavailable: 'not_configured' as const,
  repository: { ready: true },
  state: 'stopping' as const,
  running: null,
  latestBuild: null,
  latestChange: {
    kind: 'stop' as const,
    status: 'queued' as const,
    requestedAt: new Date('2026-11-24T10:00:00.000Z'),
    finishedAt: null,
    failure: null,
  },
  controller: { connected: true },
};

function endpoint(stop: () => Promise<unknown>) {
  return new StopPreviewEndpoint(
    { execute: stop } as unknown as RequestPreviewStopHandler,
    { execute: () => Promise.resolve(VIEW) } as unknown as GetPreviewHandler,
  );
}

describe('StopPreviewEndpoint', () => {
  it('answers the Preview in the contract shape after it asked for the stop', async () => {
    const stop = vi.fn(() => Promise.resolve({ operationId: 'x' }));

    const answer = await endpoint(stop).request('project');

    expect(stop).toHaveBeenCalledWith({ projectId: 'project' });
    expect(previewSchema.safeParse(answer).success).toBe(true);
    expect(answer.state).toBe('stopping');
    expect(answer.latestChange?.requestedAt).toBe('2026-11-24T10:00:00.000Z');
  });

  it.each([
    [
      'an unknown project',
      new ProjectNotFoundError(),
      404,
      ENVIRONMENTS_PROBLEM_TYPES.projectNotFound,
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
      'a stop or reset under way',
      new PreviewBusyError(),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.previewBusy,
    ],
    [
      'a Preview that does not run',
      new PreviewNotRunningError(),
      409,
      ENVIRONMENTS_PROBLEM_TYPES.previewNotRunning,
    ],
  ] as const)('maps %s', async (_name, error, status, type) => {
    const caught = await endpoint(() => Promise.reject(error))
      .request('project')
      .catch((reason: unknown) => reason);

    expect(caught).toBeInstanceOf(ProblemException);
    expect((caught as ProblemException).getStatus()).toBe(status);
    expect((caught as ProblemException).problem.type).toBe(type);
  });

  it('lets an unexpected error through', async () => {
    const failure = new Error('boom');

    await expect(endpoint(() => Promise.reject(failure)).request('project')).rejects.toBe(failure);
  });
});
