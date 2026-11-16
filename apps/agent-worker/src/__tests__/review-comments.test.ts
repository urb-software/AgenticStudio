import { reviewCommentsResultSchema } from '@agentic-studio/contracts';
import { describe, expect, it } from 'vitest';
import { buildReviewComments, type ReviewCommentSources } from '../review-comments.js';

// Issue #146: the worker's mapping of what the Git host lists to the worker protocol's comments.

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 16, 10, minutes)).toISOString();

const sources = (overrides: Partial<ReviewCommentSources> = {}): ReviewCommentSources => ({
  reviews: [],
  inline: [],
  conversation: [],
  resolved: new Set(),
  agentLogin: 'agent-bot',
  more: false,
  ...overrides,
});

const conversation = (id: number, body: string, createdAt = at(1), author = 'octocat') => ({
  id,
  author,
  body,
  createdAt,
});

describe('buildReviewComments', () => {
  it('answers what the shared contract accepts', () => {
    const result = buildReviewComments(
      sources({
        reviews: [{ id: 1, author: 'a', state: 'approved', body: '', submittedAt: at(1) }],
        inline: [
          {
            id: 2,
            author: 'b',
            path: 'x.ts',
            line: 1,
            diffHunk: '@@\n+x',
            body: 'y',
            createdAt: at(2),
          },
        ],
        conversation: [conversation(3, 'z', at(3))],
      }),
      { scope: 'unresolved' },
    );

    expect(reviewCommentsResultSchema.safeParse(result).success).toBe(true);
    expect(result.comments.map((comment) => comment.id)).toEqual([
      'review-1',
      'inline-2',
      'conversation-3',
    ]);
  });

  it('leaves out the Agent account whatever the case of its login', () => {
    const { comments } = buildReviewComments(
      sources({
        conversation: [conversation(1, 'mine', at(1), 'Agent-Bot'), conversation(2, 'yours')],
      }),
      { scope: 'unresolved' },
    );

    expect(comments.map((comment) => comment.id)).toEqual(['conversation-2']);
  });

  it('leaves out pending and dismissed reviews, and the summary of a review that only wraps comments', () => {
    const review = (id: number, state: string, body: string) => ({
      id,
      author: 'octocat',
      state,
      body,
      submittedAt: at(id),
    });

    const { comments } = buildReviewComments(
      sources({
        reviews: [
          review(1, 'pending', 'draft'),
          review(2, 'dismissed', 'old'),
          review(3, 'commented', '   '),
          review(4, 'commented', 'A remark.'),
          review(5, 'approved', ''),
        ],
      }),
      { scope: 'unresolved' },
    );

    expect(comments.map((comment) => [comment.id, comment.verdict])).toEqual([
      ['review-4', 'commented'],
      ['review-5', 'approved'],
    ]);
  });

  it('keeps the last six lines of the diff around an inline comment, plain', () => {
    const hunk = ['@@ -1,9 +1,9 @@', '1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');

    const { comments } = buildReviewComments(
      sources({
        inline: [
          {
            id: 1,
            author: 'a',
            path: 'x.ts',
            line: 7,
            diffHunk: hunk,
            body: 'b',
            createdAt: at(1),
          },
        ],
      }),
      { scope: 'unresolved' },
    );

    expect(comments[0]).toMatchObject({
      kind: 'inline',
      path: 'x.ts',
      line: 7,
      diffContext: '4\n5\n6\n7\n8\n9',
    });
  });

  it('strips control characters and normalizes line breaks, leaving markup as it is', () => {
    const { comments } = buildReviewComments(
      sources({
        conversation: [
          conversation(1, 'a\u0000b\r\nc <b>bold</b> [x](http://evil.test)\u001B[31m'),
        ],
      }),
      { scope: 'unresolved' },
    );

    expect(comments[0]?.text).toBe('ab\nc <b>bold</b> [x](http://evil.test)[31m');
  });

  it('cuts a text to 8 KiB in UTF-8 bytes at a character boundary and says so', () => {
    const { comments, truncated } = buildReviewComments(
      sources({ conversation: [conversation(1, 'é'.repeat(5000))] }),
      { scope: 'unresolved' },
    );

    expect(Buffer.byteLength(comments[0]!.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(comments[0]?.textCut).toBe(true);
    expect(truncated).toBe(true);
    expect(comments[0]!.text).not.toContain('�');
  });

  it('keeps the latest hundred comments when there are more, and says more existed', () => {
    const many = Array.from({ length: 101 }, (_, index) =>
      conversation(index + 1, `Comment ${index + 1}`, at(index)),
    );

    const { comments, truncated } = buildReviewComments(sources({ conversation: many }), {
      scope: 'unresolved',
    });

    expect(comments).toHaveLength(100);
    expect(comments[0]?.id).toBe('conversation-2');
    expect(comments.at(-1)?.id).toBe('conversation-101');
    expect(truncated).toBe(true);
    expect(reviewCommentsResultSchema.safeParse({ comments, truncated }).success).toBe(true);
  });

  it('counts a comment that a listing gave twice once', () => {
    const twice = conversation(7, 'Same comment.', at(2));

    const { comments } = buildReviewComments(
      sources({ conversation: [twice, conversation(8, 'Other.', at(3)), twice] }),
      { scope: 'unresolved' },
    );

    expect(comments.map((comment) => comment.id)).toEqual(['conversation-7', 'conversation-8']);
    expect(reviewCommentsResultSchema.safeParse({ comments, truncated: false }).success).toBe(true);
  });

  it('filters by time for since_last_result only', () => {
    const list = sources({
      conversation: [conversation(1, 'old', at(1)), conversation(2, 'new', at(5))],
    });

    expect(
      buildReviewComments(list, { scope: 'since_last_result', since: at(1) }).comments.map(
        (c) => c.id,
      ),
    ).toEqual(['conversation-2']);
    expect(
      buildReviewComments(list, { scope: 'since_last_result' }).comments.map((c) => c.id),
    ).toEqual(['conversation-1', 'conversation-2']);
    expect(buildReviewComments(list, { scope: 'unresolved', since: at(9) }).comments).toHaveLength(
      2,
    );
  });

  it('skips a comment with no usable date instead of failing', () => {
    const { comments } = buildReviewComments(
      sources({ conversation: [conversation(1, 'x', 'not a date'), conversation(2, 'y')] }),
      { scope: 'unresolved' },
    );

    expect(comments.map((comment) => comment.id)).toEqual(['conversation-2']);
  });
});
