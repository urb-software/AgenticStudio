import { Inject, Injectable } from '@nestjs/common';
import type { ReviewCommentKind } from '../../../domain/value-objects/review-comment-kind.js';
import type { ReviewVerdict } from '../../../domain/value-objects/review-verdict.js';
import { isRunId } from '../../../domain/value-objects/run-id.js';
import type { ReviewCommentScope } from '../../../domain/value-objects/review-comment-scope.js';
import {
  REVIEW_COMMENT_REPOSITORY,
  type ReviewCommentRepository,
} from '../../../domain/repositories/review-comment-repository.js';
import {
  RUN_LOOKUP_REPOSITORY,
  type RunLookupRepository,
} from '../../../domain/repositories/run-lookup-repository.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { OPERATOR_LOGIN, type OperatorLogin } from '../../ports/operator-login.js';
import { RunNotFoundError } from '../../../domain/errors/run-errors.js';

export interface GetReviewCommentsInput {
  runId: string;
}

export interface GetReviewCommentsComment {
  id: string;
  author: string;
  kind: ReviewCommentKind;
  path?: string;
  line?: number;
  diffContext?: string;
  verdict?: ReviewVerdict;
  text: string;
  textCut?: true;
  createdAt: string;
  byOperator: boolean;
}

export interface GetReviewCommentsResult {
  operatorLogin: string | null;
  comments: GetReviewCommentsComment[];
  truncated: boolean;
  scope: ReviewCommentScope | null;
  loadedAt: Date | null;
  loading: boolean;
  error: string | null;
}

/** Throws {@link RunNotFoundError} (also for a non-UUID id). */
@Injectable()
export class GetReviewCommentsHandler {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(REVIEW_COMMENT_REPOSITORY) private readonly comments: ReviewCommentRepository,
    @Inject(RUN_LOOKUP_REPOSITORY) private readonly lookups: RunLookupRepository,
    @Inject(OPERATOR_LOGIN) private readonly operator: OperatorLogin,
  ) {}

  async execute(input: GetReviewCommentsInput): Promise<GetReviewCommentsResult> {
    const { runId } = input;
    if (!isRunId(runId) || !(await this.runs.exists(runId))) throw new RunNotFoundError();
    const [set, load] = await Promise.all([
      this.comments.find(runId),
      this.lookups.findReviewCommentsLoad(runId),
    ]);
    const operatorLogin = this.operator.login;
    return {
      operatorLogin,
      comments: (set?.comments ?? []).map((comment) => ({
        id: comment.id,
        author: comment.author,
        kind: comment.kind,
        ...(comment.path === undefined ? {} : { path: comment.path }),
        ...(comment.line === undefined ? {} : { line: comment.line }),
        ...(comment.diffContext === undefined ? {} : { diffContext: comment.diffContext }),
        ...(comment.verdict === undefined ? {} : { verdict: comment.verdict }),
        text: comment.text,
        ...(comment.textCut === undefined ? {} : { textCut: comment.textCut }),
        createdAt: comment.createdAt,
        byOperator: comment.isBy(operatorLogin),
      })),
      truncated: set?.truncated ?? false,
      scope: set?.scope ?? null,
      loadedAt: set?.loadedAt ?? null,
      loading: load.loading,
      error: load.error,
    };
  }
}
