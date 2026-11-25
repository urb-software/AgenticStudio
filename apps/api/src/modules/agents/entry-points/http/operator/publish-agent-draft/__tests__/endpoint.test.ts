import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { PublishAgentDraftHandler } from '../../../../../application/features/publish-agent-draft/handler.js';
import { WriteRefusedError } from '../../../../../domain/errors/agent-publish-errors.js';
import { AGENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { PublishAgentDraftEndpoint } from '../endpoint.js';
import { publishAgentDraftRequestSchema } from '../schema.js';

const BASE = 'a'.repeat(40);
const body = { message: 'Add the reviewer', baseCommit: BASE, version: 3 };

describe('PublishAgentDraftEndpoint', () => {
  it('answers the commit the publish made', async () => {
    const execute = vi.fn(() => Promise.resolve({ commit: 'b'.repeat(40) }));
    const endpoint = new PublishAgentDraftEndpoint({
      execute,
    } as unknown as PublishAgentDraftHandler);

    await expect(endpoint.publish(body)).resolves.toEqual({ commit: 'b'.repeat(40) });

    expect(execute).toHaveBeenCalledWith(body);
  });

  it('answers a refusal as a problem of its own type', async () => {
    const execute = vi.fn(() => Promise.reject(new WriteRefusedError()));
    const endpoint = new PublishAgentDraftEndpoint({
      execute,
    } as unknown as PublishAgentDraftHandler);

    const error: unknown = await endpoint.publish(body).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).getStatus()).toBe(409);
    expect((error as ProblemException).problem.type).toBe(AGENTS_PROBLEM_TYPES.writeRefused);
  });
});

describe('publishAgentDraftRequestSchema', () => {
  it('takes a message, a base commit and a version', () => {
    expect(publishAgentDraftRequestSchema.parse(body)).toEqual(body);
    expect(
      publishAgentDraftRequestSchema.parse({ ...body, baseCommit: 'c'.repeat(64) }).baseCommit,
    ).toHaveLength(64);
  });

  it.each([
    ['no message', { ...body, message: undefined }],
    ['an empty message', { ...body, message: '' }],
    ['a message over 2,000 characters', { ...body, message: 'x'.repeat(2001) }],
    ['a message with a NUL', { ...body, message: 'a\0b' }],
    ['a base that is not a commit id', { ...body, baseCommit: 'main' }],
    ['an upper-case commit id', { ...body, baseCommit: 'A'.repeat(40) }],
    ['a negative version', { ...body, version: -1 }],
    ['a fractional version', { ...body, version: 1.5 }],
    ['an identity of the request', { ...body, identity: { name: 'x', email: 'x@y.z' } }],
    ['an author', { ...body, author: 'x' }],
  ])('refuses %s', (_name, candidate) => {
    expect(publishAgentDraftRequestSchema.safeParse(candidate).success).toBe(false);
  });
});
