import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  pullRequestNotRefreshable,
  runNotFound,
} from '../../contracts/http/problems.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import {
  ReviewCommentsResponseDto,
  toReviewCommentsResponse,
} from '../get-review-comments/schema.js';
import { PullRequestNotRefreshableError } from '../refresh-pull-request/handler.js';
import { LoadReviewCommentsHandler } from './handler.js';
import { loadReviewCommentsRequestSchema, LoadReviewCommentsRequestDto } from './schema.js';

/**
 * `POST /api/runs/:runId/pull-request/review-comments/load` (Issue #146), behind the global
 * session and mutation Origin guards: 202 with the Run's Review comments as they are now, marked
 * as loading while an agent worker reads them (a second request while one is under way is that
 * one); 404 for an unknown Run; 409 for a Run without a pull request; 422 for an invalid body.
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
    409: `The run has no pull request (${EXECUTIONS_PROBLEM_TYPES.pullRequestNotRefreshable})`,
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
      const { view, operatorLogin } = await this.handler.execute(runId, parsed.data.scope);
      return toReviewCommentsResponse(view, operatorLogin);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PullRequestNotRefreshableError) throw pullRequestNotRefreshable();
      throw error;
    }
  }
}
