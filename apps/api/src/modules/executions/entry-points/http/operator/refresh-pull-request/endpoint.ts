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
  pullRequestNotRefreshable,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import { RefreshPullRequestHandler } from '../../../../application/features/refresh-pull-request/handler.js';
import { refreshPullRequestRequestSchema, RefreshPullRequestRequestDto } from './schema.js';
import {
  RunNotFoundError,
  PullRequestNotRefreshableError,
} from '../../../../domain/value-objects/run-errors.js';

/**
 * `POST /api/runs/:runId/pull-request/refresh` (Issue #142), behind the global session and
 * mutation Origin guards: 202 with the Run, marked as refreshing while an agent worker reads
 * the pull request (a request is recorded at most once a minute per Run when the Run page asks
 * on opening, and never twice at once); 404 for an unknown Run; 409 for a Run without a pull
 * request; 422 for an invalid body. The body is optional and typed `unknown`, so the global pipe
 * leaves it alone.
 */
@ApiTags('runs')
@Controller('runs')
export class RefreshPullRequestEndpoint {
  constructor(private readonly handler: RefreshPullRequestHandler) {}

  @Post(':runId/pull-request/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'refreshRunPullRequest' })
  @ApiBody({ type: RefreshPullRequestRequestDto, required: false })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run has no pull request (${EXECUTIONS_PROBLEM_TYPES.pullRequestNotRefreshable})`,
    422: 'Invalid request body (field errors)',
  })
  async refresh(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = refreshPullRequestRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      const { run, followUp, workerConnected, preparedFollowUp } = await this.handler.execute({
        runId,
        onOpen: parsed.data.onOpen === true,
      });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp), followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PullRequestNotRefreshableError) throw pullRequestNotRefreshable();
      throw error;
    }
  }
}
