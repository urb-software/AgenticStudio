import { describe, expect, it, vi } from 'vitest';
import { ProblemException } from '../../../../../../../platform/http/problem-details.js';
import type { SaveAgentDraftFileHandler } from '../../../../../application/features/save-agent-draft-file/handler.js';
import { DraftTooManyFilesError } from '../../../../../domain/errors/agent-draft-errors.js';
import { AGENTS_PROBLEM_TYPES } from '../../../shared/problems.js';
import { SaveAgentDraftFileEndpoint } from '../endpoint.js';
import { saveAgentDraftFileRequestSchema } from '../schema.js';

const VIEW = {
  baseCommit: 'a'.repeat(40),
  currentCommit: 'a'.repeat(40),
  version: 1,
  files: [{ path: 'docs/a.md', change: 'added' as const, size: 2, movedFrom: null, skill: null }],
  problems: [],
  skillProblems: [],
  movedUpstream: [],
};

function endpointWith(execute = vi.fn(() => Promise.resolve(VIEW))) {
  return {
    execute,
    endpoint: new SaveAgentDraftFileEndpoint({ execute } as unknown as SaveAgentDraftFileHandler),
  };
}

describe('SaveAgentDraftFileEndpoint', () => {
  it('hands the handler the text as UTF-8 bytes and answers the Draft', async () => {
    const { endpoint, execute } = endpointWith();

    await expect(endpoint.save({ path: 'docs/a.md', text: 'café' })).resolves.toEqual(VIEW);

    expect(execute).toHaveBeenCalledWith({
      path: 'docs/a.md',
      content: Buffer.from('café', 'utf8'),
    });
  });

  it('hands the handler the decoded bytes of a base64 body', async () => {
    const { endpoint, execute } = endpointWith();

    await endpoint.save({
      path: 'a.bin',
      contentBase64: Buffer.from([0, 255, 7]).toString('base64'),
    });

    expect(execute).toHaveBeenCalledWith({ path: 'a.bin', content: Buffer.from([0, 255, 7]) });
  });

  it('maps what the Draft refuses to its own problem', async () => {
    const { endpoint } = endpointWith(vi.fn(() => Promise.reject(new DraftTooManyFilesError(200))));

    const error: unknown = await endpoint.save({ path: 'a', text: 'x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProblemException);
    expect((error as ProblemException).problem.type).toBe(AGENTS_PROBLEM_TYPES.draftTooManyFiles);
  });
});

describe('saveAgentDraftFileRequestSchema', () => {
  const parse = (body: unknown) => saveAgentDraftFileRequestSchema.safeParse(body).success;

  it('takes exactly one of text and base64', () => {
    expect(parse({ path: 'a.md', text: '' })).toBe(true);
    expect(parse({ path: 'a.bin', contentBase64: '' })).toBe(true);
    expect(parse({ path: 'a.md', text: 'x', contentBase64: 'eA==' })).toBe(false);
    expect(parse({ path: 'a.md' })).toBe(false);
  });

  it('refuses malformed base64, an unsafe path and an unknown member', () => {
    expect(parse({ path: 'a.bin', contentBase64: 'not base64!' })).toBe(false);
    expect(parse({ path: 'a.bin', contentBase64: 'eA' })).toBe(false);
    expect(parse({ path: '../a.md', text: 'x' })).toBe(false);
    expect(parse({ path: 'a.md', text: 'x', extra: 1 })).toBe(false);
  });
});
