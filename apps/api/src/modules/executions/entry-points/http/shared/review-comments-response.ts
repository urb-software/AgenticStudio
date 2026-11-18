import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const REVIEW_COMMENT_KINDS = ['review', 'inline', 'conversation'] as const;
const REVIEW_COMMENT_SCOPES = ['since_last_result', 'unresolved'] as const;
const REVIEW_VERDICTS = ['commented', 'changes_requested', 'approved'] as const;

/**
 * `byOperator` (the operator's own GitHub account) is the only ground for preselecting a comment.
 * The text, diff context and file are untrusted text from the Git host: redacted and capped by
 * Studio, shown only as plain text.
 */
export const reviewCommentResponseSchema = z
  .object({
    /** Unique within the pull request: `review-<n>`, `inline-<n>` or `conversation-<n>`. */
    id: z.string(),
    author: z.string(),
    byOperator: z.boolean(),
    kind: z.enum(REVIEW_COMMENT_KINDS),
    path: z.string().optional(),
    line: z.int().optional(),
    diffContext: z.string().optional(),
    verdict: z.enum(REVIEW_VERDICTS).optional(),
    text: z.string(),
    textCut: z.literal(true).optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ReviewComment' });

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

export interface ReviewCommentsResponseInput {
  operatorLogin: string | null;
  comments: z.infer<typeof reviewCommentResponseSchema>[];
  truncated: boolean;
  scope: (typeof REVIEW_COMMENT_SCOPES)[number] | null;
  loadedAt: Date | null;
  loading: boolean;
  error: string | null;
}

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
