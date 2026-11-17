import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  followUpNotAllowed,
  pullRequestNotRefreshable,
  reviewCommentsLoadRunning,
  runNotFound,
} from '../../shared/problems.js';
import {
  ReviewCommentsResponseDto,
  toReviewCommentsResponse,
} from '../../shared/review-comments-response.js';
import { ReviewCommentsLoadRunningError } from '../../../../domain/value-objects/review-comments.js';
import { FollowUpNotAllowedError } from '../../../../domain/value-objects/run-errors.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import { PullRequestNotRefreshableError } from '../../../../domain/value-objects/run-lookup.js';
import { LoadReviewCommentsHandler } from '../../../../application/features/load-review-comments/handler.js';
import { loadReviewCommentsRequestSchema, LoadReviewCommentsRequestDto } from './schema.js';

/**
 * `POST /api/runs/:runId/pull-request/review-comments/load` (Issue #146), behind the global
 * session and mutation Origin guards: 202 with the Run's Review comments as they are now, marked
 * as loading while an agent worker reads them; 404 for an unknown Run; 409 for a Run without a
 * pull request, for a Run that cannot take a Follow-up now (the detail says why: the page offers
 * loading only then) and while a load is under way already (it keeps its own scope); 422 for an
 * invalid body.
 * Nothing is sent to an agent, and no agent is started. The body is typed `unknown`, so the
 * global pipe leaves it alone and an invalid body becomes a 422 here.
 */
@ApiTags('runs')
@Controller('runs')
export class LoadReviewCommentsEndpoint {
  constructor(private readonly handler: LoadReviewCommentsHandler) {}

  @Post(':runId/pull-request/review-comments/load')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'loadRunReviewComments' })
  @ApiBody({ type: LoadReviewCommentsRequestDto })
  @ZodResponse({ status: 202, type: ReviewCommentsResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run has no pull request (${EXECUTIONS_PROBLEM_TYPES.pullRequestNotRefreshable}), cannot take a Follow-up (${EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed}) or a load is running (${EXECUTIONS_PROBLEM_TYPES.reviewCommentsLoadRunning})`,
    422: 'Invalid request body (field errors)',
  })
  async load(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = loadReviewCommentsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      return toReviewCommentsResponse(
        await this.handler.execute({ runId, scope: parsed.data.scope }),
      );
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PullRequestNotRefreshableError) throw pullRequestNotRefreshable();
      if (error instanceof FollowUpNotAllowedError) throw followUpNotAllowed(error.reason);
      if (error instanceof ReviewCommentsLoadRunningError) throw reviewCommentsLoadRunning();
      throw error;
    }
  }
}
