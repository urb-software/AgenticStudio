import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { RemovePreviewSettingsHandler } from '../../../../../application/features/remove-preview-settings/handler.js';
import {
  PreviewBuildRunningError,
  PreviewRunningError,
  ProjectNotFoundError,
} from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { RemovePreviewSettingsEndpoint } from '../endpoint.js';

function endpointFailing(error: Error) {
  const handler = { execute: vi.fn(() => Promise.reject(error)) };
  return new RemovePreviewSettingsEndpoint(handler as unknown as RemovePreviewSettingsHandler);
}

describe('RemovePreviewSettingsEndpoint', () => {
  it('answers nothing when the settings were removed', async () => {
    const handler = { execute: vi.fn(() => Promise.resolve()) };
    const endpoint = new RemovePreviewSettingsEndpoint(
      handler as unknown as RemovePreviewSettingsHandler,
    );

    await expect(endpoint.remove('id')).resolves.toBeUndefined();
    expect(handler.execute).toHaveBeenCalledWith({ projectId: 'id' });
  });

  it('maps an unknown project to 404', async () => {
    const error = await endpointFailing(new ProjectNotFoundError())
      .remove('id')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).getStatus()).toBe(404);
  });

  it('maps a running Preview to 409', async () => {
    const error = await endpointFailing(new PreviewRunningError())
      .remove('id')
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).getStatus()).toBe(409);
    expect((error as ProblemException).problem.type).toBe(
      ENVIRONMENTS_PROBLEM_TYPES.previewRunning,
    );
  });

  it('maps a running build to 409 with its own type', async () => {
    const error = await endpointFailing(new PreviewBuildRunningError())
      .remove('id')
      .catch((reason: unknown) => reason);

    expect((error as ProblemException).getStatus()).toBe(409);
    expect((error as ProblemException).problem.type).toBe(ENVIRONMENTS_PROBLEM_TYPES.buildRunning);
  });
});
