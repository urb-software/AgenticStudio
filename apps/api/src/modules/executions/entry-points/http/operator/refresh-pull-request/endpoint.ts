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
import { RunResponseDto, toRunResponse } from '../../shared/run-response.js';
import { RefreshPullRequestHandler } from '../../../../application/features/refresh-pull-request/handler.js';
import { refreshPullRequestRequestSchema, RefreshPullRequestRequestDto } from './schema.js';
import { GetRunHandler } from '../../../../application/features/get-run/handler.js';
import {
  RunNotFoundError,
  PullRequestNotRefreshableError,
} from '../../../../domain/errors/run-errors.js';

@ApiTags('runs')
@Controller('runs')
export class RefreshPullRequestEndpoint {
  constructor(
    private readonly handler: RefreshPullRequestHandler,
    private readonly getRun: GetRunHandler,
  ) {}

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
      await this.handler.execute({
        runId,
        onOpen: parsed.data.onOpen === true,
      });
      const { run, followUp, merge, latestMergeApproval, integrationBranch, previewAfterMerge } =
        await this.getRun.execute({
          runId,
        });
      return toRunResponse(
        run,
        followUp,
        merge,
        latestMergeApproval,
        integrationBranch,
        previewAfterMerge,
      );
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PullRequestNotRefreshableError) throw pullRequestNotRefreshable();
      throw error;
    }
  }
}
