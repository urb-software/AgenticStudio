import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { DiscardAgentDraftHandler } from '../../../../../application/features/discard-agent-draft/handler.js';
import { DraftChangedConcurrentlyError } from '../../../../../domain/errors/agent-draft-errors.js';
import { AGENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { DiscardAgentDraftEndpoint } from '../endpoint.js';

const VIEW = {
  baseCommit: null,
  currentCommit: null,
  version: 4,
  files: [],
  problems: [],
  skillProblems: [],
  judged: true,
  notJudgedReason: null,
  movedUpstream: [],
};

describe('DiscardAgentDraftEndpoint', () => {
  it('answers the empty Draft', async () => {
    const execute = vi.fn(() => Promise.resolve(VIEW));
    const endpoint = new DiscardAgentDraftEndpoint({
      execute,
    } as unknown as DiscardAgentDraftHandler);

    await expect(endpoint.discard()).resolves.toEqual(VIEW);
  });

  it('answers 409 agent-draft-conflict when every attempt lost a race', async () => {
    const execute = vi.fn(() => Promise.reject(new DraftChangedConcurrentlyError()));
    const endpoint = new DiscardAgentDraftEndpoint({
      execute,
    } as unknown as DiscardAgentDraftHandler);

    const error: unknown = await endpoint.discard().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).getStatus()).toBe(409);
    expect((error as ProblemException).problem.type).toBe(AGENTS_PROBLEM_TYPES.draftConflict);
  });
});
