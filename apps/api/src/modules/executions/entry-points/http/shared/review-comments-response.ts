import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The lists below repeat the domain's (a contract may not import the domain, backend.md section 2);
 * a test pins them to it.
 */
const REVIEW_COMMENT_KINDS = ['review', 'inline', 'conversation'] as const;
const REVIEW_COMMENT_SCOPES = ['since_last_result', 'unresolved'] as const;
const REVIEW_VERDICTS = ['commented', 'changes_requested', 'approved'] as const;

/**
 * A Review comment as the Run page gets it (Issue #146): `byOperator` says it was written by the
 * operator's own GitHub account (`STUDIO_OPERATOR_GITHUB_LOGIN`; exact, case-insensitive), which
 * is the only ground for preselecting it. The text, the diff context and the file are untrusted
 * text from the Git host (anyone can comment on a public pull request): redacted and capped by
 * Studio, shown only as plain text. `textCut` marks a text cut to its size limit.
 */
export const reviewCommentResponseSchema = z
  .object({
    /** Unique within the pull request: `review-<n>`, `inline-<n>` or `conversation-<n>`. */
    id: z.string(),
    author: z.string(),
    byOperator: z.boolean(),
    kind: z.enum(REVIEW_COMMENT_KINDS),
    /** An inline comment's file, line and the diff lines around it. */
    path: z.string().optional(),
    line: z.int().optional(),
    diffContext: z.string().optional(),
    /** A review summary's verdict. */
    verdict: z.enum(REVIEW_VERDICTS).optional(),
    text: z.string(),
    textCut: z.literal(true).optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ReviewComment' });

/**
 * The Run's loaded Review comments (Issue #146): `operatorLogin` (when configured; shown as
 * "Showing comments by ..."), the comments in the order they were written, and whether more
 * existed than are kept or a text was cut (`truncated`). `scope` and `loadedAt` say what the set
 * is (absent until the first load). `loading` is true while a load waits for an agent worker or
 * is being answered; `error` is why the latest load failed, in the worker's words (redacted).
 */
export const reviewCommentsResponseSchema = z
  .object({
    operatorLogin: z.string().optional(),
    comments: z.array(reviewCommentResponseSchema),
    truncated: z.boolean(),
    scope: z.enum(REVIEW_COMMENT_SCOPES).optional(),
    loadedAt: z.iso.datetime().optional(),
    loading: z.boolean(),
    error: z.string().optional(),
  })
  .meta({ id: 'ReviewComments' });

export type ReviewCommentsResponse = z.infer<typeof reviewCommentsResponseSchema>;

export class ReviewCommentsResponseDto extends createZodDto(reviewCommentsResponseSchema) {}

/**
 * What the response is built from: a plain shape the handlers make (a contract may not import the
 * domain), with `byOperator` already worked out from the configured login.
 */
export interface ReviewCommentsResponseInput {
  operatorLogin: string | null;
  comments: z.infer<typeof reviewCommentResponseSchema>[];
  truncated: boolean;
  scope: (typeof REVIEW_COMMENT_SCOPES)[number] | null;
  loadedAt: Date | null;
  loading: boolean;
  error: string | null;
}

/** The response for the Run's loaded Review comments. */
export function toReviewCommentsResponse(
  view: ReviewCommentsResponseInput,
): ReviewCommentsResponse {
  return {
    ...(view.operatorLogin === null ? {} : { operatorLogin: view.operatorLogin }),
    comments: view.comments.map((comment) => ({ ...comment })),
    truncated: view.truncated,
    ...(view.scope === null || view.loadedAt === null
      ? {}
      : { scope: view.scope, loadedAt: view.loadedAt.toISOString() }),
    loading: view.loading,
    ...(view.error === null ? {} : { error: view.error }),
  };
}
