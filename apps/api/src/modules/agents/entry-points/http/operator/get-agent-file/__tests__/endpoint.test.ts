import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type {
  ReadAgentFileHandler,
  ReadAgentFileResult,
} from '../../../../../application/features/read-agent-file/handler.js';
import { AGENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { GetAgentFileEndpoint } from '../endpoint.js';
import { getAgentFileQuerySchema } from '../schema.js';

const COMMIT = 'a'.repeat(40);

function endpointAnswering(result: ReadAgentFileResult) {
  const handler = { execute: vi.fn(() => Promise.resolve(result)) };
  return {
    handler,
    endpoint: new GetAgentFileEndpoint(handler as unknown as ReadAgentFileHandler),
  };
}

describe('GetAgentFileEndpoint', () => {
  it('answers a text file with its content and no size', async () => {
    const { endpoint, handler } = endpointAnswering({
      status: 'read',
      commit: COMMIT,
      path: 'a.md',
      content: { kind: 'text', content: '# hi\n' },
    });

    await expect(endpoint.get({ path: 'a.md', commit: COMMIT })).resolves.toEqual({
      commit: COMMIT,
      path: 'a.md',
      kind: 'text',
      content: '# hi\n',
    });
    expect(handler.execute).toHaveBeenCalledWith({ path: 'a.md', commit: COMMIT });
  });

  it.each(['binary', 'too_large'] as const)(
    'answers %s with its size and no content',
    async (kind) => {
      const { endpoint } = endpointAnswering({
        status: 'read',
        commit: COMMIT,
        path: 'a.bin',
        content: { kind, size: 7 },
      });

      await expect(endpoint.get({ path: 'a.bin' })).resolves.toEqual({
        commit: COMMIT,
        path: 'a.bin',
        kind,
        size: 7,
      });
    },
  );

  it.each([
    ['not_found', 404, AGENTS_PROBLEM_TYPES.agentFileNotFound],
    ['commit_missing', 404, AGENTS_PROBLEM_TYPES.agentCommitNotFound],
    ['unreadable', 503, AGENTS_PROBLEM_TYPES.agentFilesUnreadable],
  ] as const)('answers %s as the problem %s', async (status, http, type) => {
    const { endpoint } = endpointAnswering({ status });

    const error = await endpoint.get({ path: 'a.md' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).getStatus()).toBe(http);
    expect((error as ProblemException).problem.type).toBe(type);
  });
});

describe('the query of the agent file route', () => {
  it.each(['agents/a/AGENT.md', 'README.md', 'docs/my notes é.txt', 'a/b/c/d.txt'])(
    'accepts the path %j',
    (path) => {
      expect(getAgentFileQuerySchema.safeParse({ path }).success).toBe(true);
    },
  );

  it.each([
    '../x',
    'agents/../../x',
    'a/../b',
    '/etc/passwd',
    'a\\b',
    './a',
    'a//b',
    'a/',
    '.git/config',
    'a/.GIT/x',
    '',
    'a\u0000b',
    'x'.repeat(256),
  ])('refuses the path %j', (path) => {
    expect(getAgentFileQuerySchema.safeParse({ path }).success).toBe(false);
  });

  it('accepts a full commit id in lower-case hex, and none', () => {
    expect(getAgentFileQuerySchema.safeParse({ path: 'a', commit: COMMIT }).success).toBe(true);
    expect(getAgentFileQuerySchema.safeParse({ path: 'a', commit: 'b'.repeat(64) }).success).toBe(
      true,
    );
    expect(getAgentFileQuerySchema.safeParse({ path: 'a' }).success).toBe(true);
  });

  it.each(['HEAD', 'main', 'A'.repeat(40), 'a'.repeat(7), 'a'.repeat(41), `${COMMIT}\n`])(
    'refuses the commit %j',
    (commit) => {
      expect(getAgentFileQuerySchema.safeParse({ path: 'a', commit }).success).toBe(false);
    },
  );

  it('refuses an unknown query parameter', () => {
    expect(getAgentFileQuerySchema.safeParse({ path: 'a', extra: '1' }).success).toBe(false);
  });
});
