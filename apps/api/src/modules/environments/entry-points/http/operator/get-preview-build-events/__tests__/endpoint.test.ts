import { previewBuildEventsSchema } from '@agentic-studio/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { GetPreviewBuildEventsHandler } from '../../../../../application/features/get-preview-build-events/handler.js';
import { PreviewBuildNotFoundError } from '../../../../../domain/errors/preview-operation-errors.js';
import { ProjectNotFoundError } from '../../../../../domain/errors/preview-settings-errors.js';
import { ENVIRONMENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { GetPreviewBuildEventsEndpoint } from '../endpoint.js';
import { getPreviewBuildEventsQuerySchema } from '../schema.js';

function endpoint(execute: () => Promise<unknown>) {
  return new GetPreviewBuildEventsEndpoint({ execute } as unknown as GetPreviewBuildEventsHandler);
}

describe('GetPreviewBuildEventsEndpoint', () => {
  it('answers a page in the contract shape, with ISO times', async () => {
    const execute = vi.fn(() =>
      Promise.resolve({
        events: [
          {
            seq: 1,
            at: new Date('2026-11-24T10:00:00.000Z'),
            stream: 'build' as const,
            text: 'step 1/3',
            truncated: false,
            redacted: false,
          },
        ],
        next: 1,
        final: false,
        truncated: false,
      }),
    );

    const answer = await endpoint(execute).list('project', 'build', { after: 0, limit: 500 });

    expect(previewBuildEventsSchema.safeParse(answer).success).toBe(true);
    expect(answer.events[0]?.at).toBe('2026-11-24T10:00:00.000Z');
    expect(execute).toHaveBeenCalledWith({
      projectId: 'project',
      buildId: 'build',
      after: 0,
      limit: 500,
    });
  });

  it.each([
    [new ProjectNotFoundError(), ENVIRONMENTS_PROBLEM_TYPES.projectNotFound],
    [new PreviewBuildNotFoundError(), ENVIRONMENTS_PROBLEM_TYPES.buildNotFound],
  ])('maps %s to 404', async (error, type) => {
    const caught = await endpoint(() => Promise.reject(error))
      .list('project', 'build', { after: 0, limit: 500 })
      .catch((reason: unknown) => reason);

    expect(caught).toBeInstanceOf(ProblemException);
    expect((caught as ProblemException).getStatus()).toBe(404);
    expect((caught as ProblemException).problem.type).toBe(type);
  });
});

describe('the events query', () => {
  it('defaults to the first 500 lines and accepts at most 1000', () => {
    expect(getPreviewBuildEventsQuerySchema.parse({})).toEqual({ after: 0, limit: 500 });
    expect(getPreviewBuildEventsQuerySchema.safeParse({ limit: '1000' }).success).toBe(true);
    expect(getPreviewBuildEventsQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
    expect(getPreviewBuildEventsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(getPreviewBuildEventsQuerySchema.safeParse({ after: '-1' }).success).toBe(false);
    expect(getPreviewBuildEventsQuerySchema.safeParse({ extra: '1' }).success).toBe(false);
  });
});
