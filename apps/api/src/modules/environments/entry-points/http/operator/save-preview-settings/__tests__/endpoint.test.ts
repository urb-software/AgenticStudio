import { describe, expect, it, vi } from 'vitest';
import {
  FieldProblemException,
  ProblemException,
} from '../../../../../../../platform/http/problem-details.js';
import type {
  SavePreviewSettingsHandler,
  SavePreviewSettingsResult,
} from '../../../../../application/features/save-preview-settings/handler.js';
import {
  PreviewRefusedError,
  PreviewRepositoryNotReadyError,
  PreviewSourceUnavailableError,
  ProjectNotFoundError,
} from '../../../../../domain/errors/preview-settings-errors.js';
import { InvalidPreviewPortError } from '../../../../../domain/value-objects/preview-port.js';
import { InvalidPreviewServiceError } from '../../../../../domain/value-objects/preview-service.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { SavePreviewSettingsEndpoint } from '../endpoint.js';

const BODY = { composeFile: 'compose.yaml', service: 'web', port: 80 };

function endpointAnswering(outcome: () => Promise<SavePreviewSettingsResult>) {
  const handler = { execute: vi.fn(outcome) };
  return new SavePreviewSettingsEndpoint(handler as unknown as SavePreviewSettingsHandler);
}

function failing(error: Error) {
  return endpointAnswering(() => Promise.reject(error)).save('id', BODY);
}

async function problemOf(promise: Promise<unknown>): Promise<ProblemException> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProblemException);
  return error as ProblemException;
}

describe('SavePreviewSettingsEndpoint', () => {
  it('answers the Preview with ISO times, and removedPorts only when some were removed', async () => {
    const view = {
      settings: { ...BODY, updatedAt: new Date('2026-11-23T10:00:00.000Z') },
      hostname: null,
      hostnameUnavailable: 'not_configured' as const,
      repository: { ready: true },
      state: 'stopped' as const,
      running: null,
      latestBuild: null,
      latestChange: null,
      controller: { connected: false },
      behind: false,
      mergeRebuild: null,
      removedPorts: [],
    };

    await expect(endpointAnswering(() => Promise.resolve(view)).save('id', BODY)).resolves.toEqual({
      settings: { ...BODY, updatedAt: '2026-11-23T10:00:00.000Z' },
      hostname: null,
      hostnameUnavailable: 'not_configured',
      repository: { ready: true },
      state: 'stopped',
      running: null,
      latestBuild: null,
      latestChange: null,
      controller: { connected: false },
      behind: false,
      mergeRebuild: null,
    });
    const removed = [{ service: 'web', place: 'services.web.ports[0]' }];
    await expect(
      endpointAnswering(() => Promise.resolve({ ...view, removedPorts: removed })).save('id', BODY),
    ).resolves.toMatchObject({ removedPorts: removed });
  });

  it('maps an unknown project to 404', async () => {
    const problem = await problemOf(failing(new ProjectNotFoundError()));

    expect(problem.getStatus()).toBe(404);
    expect(problem.problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.projectNotFound);
  });

  it.each([
    ['no_repository', ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady],
    ['repository_not_ready', ENVIRONMENTS_PROBLEM_TYPES.repositoryNotReady],
    ['unsupported_platform', ENVIRONMENTS_PROBLEM_TYPES.unsupportedPlatform],
  ] as const)('maps %s to 409', async (reason, type) => {
    const problem = await problemOf(failing(new PreviewRepositoryNotReadyError(reason)));

    expect(problem.getStatus()).toBe(409);
    expect(problem.problem.type).toBe(type);
  });

  it('maps the refusals to 422, carrying every one with its code, place and message', async () => {
    const refusals = [
      { code: 'privileged', place: 'services.web.privileged', message: 'Not allowed.' },
      { code: 'docker_socket', place: 'services.web.volumes[0]', message: 'Not allowed.' },
    ];

    const problem = await problemOf(failing(new PreviewRefusedError(refusals)));

    expect(problem.getStatus()).toBe(422);
    expect(problem.problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.previewRefused);
    expect(problem.problem.extensions).toEqual({ refusals });
  });

  it('maps an unreadable file to 502 with fixed text', async () => {
    const problem = await problemOf(failing(new PreviewSourceUnavailableError()));

    expect(problem.getStatus()).toBe(502);
    expect(problem.problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.sourceUnavailable);
  });

  it.each([
    ['service', new InvalidPreviewServiceError('Enter the service name.')],
    ['port', new InvalidPreviewPortError('The port is a whole number from 1 to 65535.')],
  ])('maps a refused %s to a 400 field error', async (path, error) => {
    const problem = await problemOf(failing(error));

    expect(problem).toBeInstanceOf(FieldProblemException);
    expect(problem.getStatus()).toBe(400);
    expect(problem.problem.errors).toEqual([{ path, message: error.message }]);
  });

  it('lets an unknown error through', async () => {
    await expect(failing(new TypeError('bug'))).rejects.toThrow(TypeError);
  });
});
