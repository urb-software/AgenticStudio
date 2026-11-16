import { createZodDto } from 'nestjs-zod';
import {
  type ReviewCommentsResponse,
  reviewCommentResponseSchema,
  reviewCommentsResponseSchema,
} from '../../contracts/http/review-comments-response.js';
import type { z } from 'zod';
import type { ReviewComment, ReviewComments } from '../../domain/entities/review-comments.js';
import { isByOperator } from '../../domain/services/review-comments.js';

export class ReviewCommentsResponseDto extends createZodDto(reviewCommentsResponseSchema) {}

function toResponseComment(
  comment: ReviewComment,
  operatorLogin: string | null,
): z.infer<typeof reviewCommentResponseSchema> {
  return {
    id: comment.id,
    author: comment.author,
    byOperator: isByOperator(comment.author, operatorLogin),
    kind: comment.kind,
    ...(comment.path === undefined ? {} : { path: comment.path }),
    ...(comment.line === undefined ? {} : { line: comment.line }),
    ...(comment.diffContext === undefined ? {} : { diffContext: comment.diffContext }),
    ...(comment.verdict === undefined ? {} : { verdict: comment.verdict }),
    text: comment.text,
    ...(comment.textCut === undefined ? {} : { textCut: comment.textCut }),
    createdAt: comment.createdAt,
  };
}

/** The response for the Run's loaded Review comments. */
export function toReviewCommentsResponse(
  view: ReviewComments,
  operatorLogin: string | null,
): ReviewCommentsResponse {
  return {
    ...(operatorLogin === null ? {} : { operatorLogin }),
    comments: (view.set?.comments ?? []).map((comment) =>
      toResponseComment(comment, operatorLogin),
    ),
    truncated: view.set?.truncated ?? false,
    ...(view.set === null
      ? {}
      : { scope: view.set.scope, loadedAt: view.set.loadedAt.toISOString() }),
    loading: view.load.loading,
    ...(view.load.error === null ? {} : { error: view.load.error }),
  };
}
