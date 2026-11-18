import { describe, expect, it } from 'vitest';
import { LogRedaction, REDACTED } from '../../value-objects/log-redaction.js';
import { ReviewComment, type ReviewCommentInput } from '../../value-objects/review-comment.js';
import { ReviewComments } from '../review-comments.js';

const comment = (overrides: Partial<ReviewCommentInput> = {}): ReviewCommentInput => ({
  id: 'conversation-1',
  author: 'octocat',
  kind: 'conversation',
  text: 'Please rename it.',
  createdAt: '2026-11-16T10:00:00.000Z',
  ...overrides,
});

const sanitize = (
  comments: readonly ReviewCommentInput[],
  truncated: boolean,
  redaction: LogRedaction,
) =>
  ReviewComments.load({
    scope: 'unresolved',
    comments,
    truncated,
    redaction,
    loadedAt: new Date('2026-11-16T12:00:00.000Z'),
  });

describe('ReviewComments.load', () => {
  it('redacts the Run known secret values and token-shaped strings, in text and diff context', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const { comments } = sanitize(
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
      LogRedaction.of(['hunter2-env-value']),
    );

    expect(comments[0]?.text).toBe(`Do not commit ${REDACTED} or ${REDACTED}`);
    expect(comments[0]?.diffContext).toBe(`+ const key = "${REDACTED}";`);
  });

  it('removes control characters but keeps line breaks and markup as plain text', () => {
    const { comments } = sanitize(
      [comment({ text: 'a\u0000b\tc\nd <i>e</i> [f](http://evil.test)\u001B' })],
      false,
      LogRedaction.of([]),
    );

    expect(comments[0]?.text).toBe('ab\tc\nd <i>e</i> [f](http://evil.test)');
  });

  it('cuts a text to 8 KiB in UTF-8 bytes at a character boundary and marks the cut', () => {
    const { comments, truncated } = sanitize(
      [comment({ text: 'é'.repeat(5000) })],
      false,
      LogRedaction.of([]),
    );

    expect(Buffer.byteLength(comments[0]!.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(comments[0]?.textCut).toBe(true);
    expect(truncated).toBe(true);
    expect(comments[0]!.text).not.toContain('�');
  });

  it('cuts a diff context to 2 KiB and says that the set was cut', () => {
    const { comments, truncated } = sanitize(
      [comment({ kind: 'inline', id: 'inline-1', diffContext: 'é'.repeat(2000) })],
      false,
      LogRedaction.of([]),
    );

    expect(Buffer.byteLength(comments[0]!.diffContext!, 'utf8')).toBeLessThanOrEqual(2 * 1024);
    expect(comments[0]?.textCut).toBeUndefined();
    expect(truncated).toBe(true);
  });

  it('holds a text to the limit after redaction, which can lengthen it', () => {
    // 700 short secrets each become a 16-character marker: the text grows past 8 KiB.
    const { comments } = sanitize(
      [comment({ text: 'abcd '.repeat(700) })],
      false,
      LogRedaction.of(['abcd']),
    );

    expect(Buffer.byteLength(comments[0]!.text, 'utf8')).toBeLessThanOrEqual(8 * 1024);
    expect(comments[0]?.textCut).toBe(true);
  });

  it('keeps the latest hundred comments and says that more existed', () => {
    const many = Array.from({ length: 105 }, (_, index) =>
      comment({ id: `conversation-${index + 1}` }),
    );

    const { comments, truncated } = sanitize(many, false, LogRedaction.of([]));

    expect(comments).toHaveLength(100);
    expect(comments[0]?.id).toBe('conversation-6');
    expect(truncated).toBe(true);
  });

  it('keeps what the worker said was truncated, and says nothing more for a clean set', () => {
    expect(sanitize([comment()], true, LogRedaction.of([])).truncated).toBe(true);
    expect(sanitize([comment()], false, LogRedaction.of([])).truncated).toBe(false);
  });

  it('never shows a login that redaction would change half-masked', () => {
    const { comments } = sanitize(
      [comment({ author: 'octocat' })],
      false,
      LogRedaction.of(['octocat']),
    );

    expect(comments[0]?.author).toBe('unknown');
  });
});

describe('selecting comments', () => {
  const set = ReviewComments.restore({
    scope: 'unresolved',
    truncated: false,
    loadedAt: new Date('2026-11-16T12:00:00.000Z'),
    comments: [
      comment({ id: 'review-1', author: 'a' }),
      comment({ id: 'inline-2', author: 'b' }),
      comment({ id: 'conversation-3', author: 'a' }),
    ],
  });

  it('takes the chosen comments in the order of the set', () => {
    expect(set.select(['conversation-3', 'review-1'])?.map((c) => c.id)).toEqual([
      'review-1',
      'conversation-3',
    ]);
  });

  it('refuses an unknown id or a repeated one', () => {
    expect(set.select(['review-1', 'review-9'])).toBeNull();
    expect(set.select(['review-1', 'review-1'])).toBeNull();
  });

  it('says what a selection comes to as values for the Follow-up: how many, and whose', () => {
    expect(set.selection(['conversation-3', 'review-1'])).toEqual({ count: 2, authors: ['a'] });
    expect(set.selection(['inline-2', 'review-1'])).toEqual({ count: 2, authors: ['a', 'b'] });
  });

  it('says nothing for a selection that is not all in the set: it is not loaded', () => {
    expect(set.selection(['review-1', 'review-9'])).toBeNull();
    expect(set.selection(['review-1', 'review-1'])).toBeNull();
  });

  it('is a plain snapshot, a copy of its values', () => {
    const snapshot = set.snapshot();

    expect(snapshot).toEqual({
      scope: 'unresolved',
      truncated: false,
      loadedAt: new Date('2026-11-16T12:00:00.000Z'),
      comments: set.comments,
    });
    expect(snapshot.comments[0]).not.toBe(set.comments[0]);
  });

  it('lists the distinct authors in order of appearance', () => {
    expect(set.distinctAuthors()).toEqual(['a', 'b']);
    const many = Array.from({ length: 30 }, (_, index) => comment({ author: `user-${index}` }));
    expect(
      ReviewComments.restore({
        scope: 'unresolved',
        comments: many,
        truncated: false,
        loadedAt: new Date('2026-11-16T12:00:00.000Z'),
      }).distinctAuthors(),
    ).toHaveLength(20);
  });
});

describe('ReviewComment.isBy', () => {
  it('matches the configured login exactly, ignoring case', () => {
    expect(ReviewComment.restore(comment({ author: 'Octo-Cat' })).isBy('octo-cat')).toBe(true);
    expect(ReviewComment.restore(comment({ author: 'octo-cat2' })).isBy('octo-cat')).toBe(false);
    expect(ReviewComment.restore(comment({ author: 'octo' })).isBy('octo-cat')).toBe(false);
  });

  it('matches nobody when no login is configured', () => {
    expect(ReviewComment.restore(comment({ author: 'octo-cat' })).isBy(null)).toBe(false);
  });
});
