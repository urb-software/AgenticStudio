import { previewSchema } from '@agentic-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { GetPreviewHandler } from '../../../../../application/features/get-preview/handler.js';
import { ProjectNotFoundError } from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { GetPreviewEndpoint } from '../endpoint.js';

describe('GetPreviewEndpoint', () => {
  it('answers the contract shape, with the time as ISO text', async () => {
    const handler = {
      execute: vi.fn(() =>
        Promise.resolve({
          settings: {
            composeFile: 'compose.yaml',
            service: 'web',
            port: 80,
            updatedAt: new Date('2026-11-23T10:00:00.000Z'),
          },
          hostname: 'preview-3f2b8c1e4d5a.example.test',
          repository: { ready: false, reason: 'repository_not_ready' as const },
          state: 'running' as const,
          running: {
            buildId: '0b2f6d52-3d0b-4d6e-8a44-6b3c1d8f2a10',
            commit: 'a'.repeat(40),
            since: new Date('2026-11-23T11:00:00.000Z'),
            url: 'https://preview-3f2b8c1e4d5a.example.test/',
          },
          latestBuild: null,
          latestChange: {
            kind: 'reset_data' as const,
            status: 'failed' as const,
            requestedAt: new Date('2026-11-23T11:30:00.000Z'),
            finishedAt: new Date('2026-11-23T11:31:00.000Z'),
            failure: { code: 'runtime_failed' as const, detail: 'Docker could not remove.' },
          },
          controller: { connected: true },
        }),
      ),
    };
    const endpoint = new GetPreviewEndpoint(handler as unknown as GetPreviewHandler);

    const answer = await endpoint.get('id');

    expect(previewSchema.safeParse(answer).success).toBe(true);
    expect(answer.settings?.updatedAt).toBe('2026-11-23T10:00:00.000Z');
    expect(answer.running?.since).toBe('2026-11-23T11:00:00.000Z');
    expect(answer.latestChange?.requestedAt).toBe('2026-11-23T11:30:00.000Z');
    expect(answer.latestChange?.finishedAt).toBe('2026-11-23T11:31:00.000Z');
  });

  it('maps an unknown project to 404', async () => {
    const handler = { execute: vi.fn(() => Promise.reject(new ProjectNotFoundError())) };
    const endpoint = new GetPreviewEndpoint(handler as unknown as GetPreviewHandler);

    const error = await endpoint.get('id').catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).getStatus()).toBe(404);
    expect((error as ProblemException).problem.type).toBe(
      ENVIRONMENTS_PROBLEM_TYPES.projectNotFound,
    );
  });
});
