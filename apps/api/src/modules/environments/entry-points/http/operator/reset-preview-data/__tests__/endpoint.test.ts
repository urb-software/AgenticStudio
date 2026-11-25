import { previewSchema } from '@agentic-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { GetPreviewHandler } from '../../../../../application/features/get-preview/handler.js';
import type { RequestPreviewResetDataHandler } from '../../../../../application/features/request-preview-reset-data/handler.js';
import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewControllerUnavailableError,
  ProjectNotFoundError,
} from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { ResetPreviewDataEndpoint } from '../endpoint.js';

const VIEW = {
  settings: null,
  hostname: null,
  hostnameUnavailable: 'not_configured' as const,
  repository: { ready: true },
  state: 'resetting_data' as const,
  running: null,
  latestBuild: null,
  latestChange: {
    kind: 'reset_data' as const,
    status: 'in_progress' as const,
    requestedAt: new Date('2026-11-24T10:00:00.000Z'),
    finishedAt: null,
    failure: null,
  },
  controller: { connected: true },
  behind: false,
  mergeRebuild: null,
};

function endpoint(reset: () => Promise<unknown>) {
  return new ResetPreviewDataEndpoint(
    { execute: reset } as unknown as RequestPreviewResetDataHandler,
    { execute: () => Promise.resolve(VIEW) } as unknown as GetPreviewHandler,
  );
}

describe('ResetPreviewDataEndpoint', () => {
  it('answers the Preview in the contract shape after it asked for the reset', async () => {
    const reset = vi.fn(() => Promise.resolve({ operationId: 'x', buildId: null }));

    const answer = await endpoint(reset).request('project');

    expect(reset).toHaveBeenCalledWith({ projectId: 'project' });
    expect(previewSchema.safeParse(answer).success).toBe(true);
    expect(answer.state).toBe('resetting_data');
    expect(answer.latestChange?.kind).toBe('reset_data');
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
  ] as const)('maps %s', async (_name, error, status, type) => {
    const caught = await endpoint(() => Promise.reject(error))
      .request('project')
      .catch((reason: unknown) => reason);

    expect(caught).toBeInstanceOf(ProblemException);
    expect((caught as ProblemException).getStatus()).toBe(status);
    expect((caught as ProblemException).problem.type).toBe(type);
  });
});
