import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { PrepareMergeReviewHandler } from '../../../../application/features/prepare-merge-review/handler.js';
import { RequestMergeReviewHandler } from '../../../../application/features/request-merge-review/handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { MergeReviewRefusedError } from '../../../../domain/errors/run-merge-review-errors.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  mergeReviewRefused,
  runNotFound,
} from '../../shared/problems.js';

@ApiTags('runs')
@Controller('runs')
export class RequestMergeReviewEndpoint {
  constructor(
    private readonly requestHandler: RequestMergeReviewHandler,
    private readonly prepareHandler: PrepareMergeReviewHandler,
  ) {}

  @Post(':runId/merge-review')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'requestRunMergeReview' })
  @ApiAcceptedResponse({ description: 'The review is being prepared in the background.' })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `No pull request (${EXECUTIONS_PROBLEM_TYPES.noPullRequest}), pull request not open (${EXECUTIONS_PROBLEM_TYPES.pullRequestNotOpen}), repository not ready (${EXECUTIONS_PROBLEM_TYPES.repositoryNotReady}), review in progress (${EXECUTIONS_PROBLEM_TYPES.reviewInProgress}) or not on Linux (${EXECUTIONS_PROBLEM_TYPES.unsupportedPlatform})`,
  })
  async request(@Param('runId') runId: string): Promise<void> {
    try {
      const { requestedAt } = await this.requestHandler.execute({ runId });
      // The preparation never throws: it stores every failure on the review.
      void this.prepareHandler.execute({ runId, requestedAt });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof MergeReviewRefusedError) throw mergeReviewRefused(error.reason);
      throw error;
    }
  }
}
