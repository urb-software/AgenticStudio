import { describe, expect, it } from 'vitest';
import type { ReviewComment } from '../../value-objects/review-comments.js';
import { REDACTED } from '../log-redaction.js';
import {
  distinctAuthors,
  isByOperator,
  sanitizeReviewComments,
  selectReviewComments,
} from '../review-comments.js';

// Issue #146: Review comments are untrusted text from the Git host. They are redacted with the
// Run's known secret values and token shapes, held to their limits in UTF-8 bytes, and chosen by id.

const comment = (overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'conversation-1',
  author: 'octocat',
  kind: 'conversation',
  text: 'Please rename it.',
  createdAt: '2026-11-16T10:00:00.000Z',
  ...overrides,
});

describe('sanitizeReviewComments', () => {
  it('redacts the Run known secret values and token-shaped strings, in text and diff context', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const { comments } = sanitizeReviewComments(
      [
        comment({
          kind: 'inline',
          id: 'inline-2',
          path: 'a.ts',
          line: 1,
          diffContext: '+ const key = "hunter2-env-value";',
          text: `Do not commit ${token} or hunter2-env-value`,
        }),
      ],
      false,
      ['hunter2-env-value'],
    );

    expect(comments[0]?.text).toBe(`Do not commit ${REDACTED} or ${REDACTED}`);
    expect(comments[0]?.diffContext).toBe(`+ const key = "${REDACTED}";`);
  });

  it('removes control characters but keeps line breaks and markup as plain text', () => {
    const { comments } = sanitizeReviewComments(
      [comment({ text: 'a\u0000b\tc\nd <i>e</i> [f](http://evil.test)\u001B' })],
      false,
      [],
    );

    expect(comments[0]?.text).toBe('ab\tc\nd <i>e</i> [f](http://evil.test)');
  });

  it('cuts a text to 8 KiB in UTF-8 bytes at a character boundary and marks the cut', () => {
    const { comments, truncated } = sanitizeReviewComments(
      [comment({ text: 'é'.repeat(5000) })],
      false,
      [],
    );

    expect(Buffer.byteLength(comments[0]!.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(comments[0]?.textCut).toBe(true);
    expect(truncated).toBe(true);
    expect(comments[0]!.text).not.toContain('�');
  });

  it('holds a text to the limit after redaction, which can lengthen it', () => {
    // 700 short secrets each become a 16-character marker: the text grows past 8 KiB.
    const { comments } = sanitizeReviewComments([comment({ text: 'abcd '.repeat(700) })], false, [
      'abcd',
    ]);

    expect(Buffer.byteLength(comments[0]!.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(comments[0]?.textCut).toBe(true);
  });

  it('keeps the latest hundred comments and says that more existed', () => {
    const many = Array.from({ length: 105 }, (_, index) =>
      comment({ id: `conversation-${index + 1}` }),
    );

    const { comments, truncated } = sanitizeReviewComments(many, false, []);

    expect(comments).toHaveLength(100);
    expect(comments[0]?.id).toBe('conversation-6');
    expect(truncated).toBe(true);
  });

  it('keeps what the worker said was truncated, and says nothing more for a clean set', () => {
    expect(sanitizeReviewComments([comment()], true, []).truncated).toBe(true);
    expect(sanitizeReviewComments([comment()], false, []).truncated).toBe(false);
  });

  it('never shows a login that redaction would change half-masked', () => {
    const { comments } = sanitizeReviewComments([comment({ author: 'octocat' })], false, [
      'octocat',
    ]);

    expect(comments[0]?.author).toBe('unknown');
  });
});

describe('selecting comments', () => {
  const set = {
    comments: [
      comment({ id: 'review-1', author: 'a' }),
      comment({ id: 'inline-2', author: 'b' }),
      comment({ id: 'conversation-3', author: 'a' }),
    ],
  };

  it('takes the chosen comments in the order of the set', () => {
    expect(selectReviewComments(set, ['conversation-3', 'review-1'])?.map((c) => c.id)).toEqual([
      'review-1',
      'conversation-3',
    ]);
  });

  it('refuses an unknown id or a repeated one', () => {
    expect(selectReviewComments(set, ['review-1', 'review-9'])).toBeNull();
    expect(selectReviewComments(set, ['review-1', 'review-1'])).toBeNull();
  });

  it('lists the distinct authors in order of appearance', () => {
    expect(distinctAuthors(set.comments)).toEqual(['a', 'b']);
    const many = Array.from({ length: 30 }, (_, index) => comment({ author: `user-${index}` }));
    expect(distinctAuthors(many)).toHaveLength(20);
  });
});

describe('isByOperator', () => {
  it('matches the configured login exactly, ignoring case', () => {
    expect(isByOperator('Octo-Cat', 'octo-cat')).toBe(true);
    expect(isByOperator('octo-cat2', 'octo-cat')).toBe(false);
    expect(isByOperator('octo', 'octo-cat')).toBe(false);
  });

  it('matches nobody when no login is configured', () => {
    expect(isByOperator('octo-cat', null)).toBe(false);
  });
});
