import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  noFailingChecks,
  pullRequestNotRefreshable,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse } from '../../shared/run-response.js';
import {
  NoFailingChecksError,
  PrepareFailingChecksHandler,
} from '../../../../application/features/prepare-failing-checks/handler.js';
import { GetRunHandler } from '../../../../application/features/get-run/handler.js';
import {
  RunNotFoundError,
  PullRequestNotRefreshableError,
} from '../../../../domain/errors/run-errors.js';

@ApiTags('runs')
@Controller('runs')
export class PrepareFailingChecksEndpoint {
  constructor(
    private readonly handler: PrepareFailingChecksHandler,
    private readonly getRun: GetRunHandler,
  ) {}

  @Post(':runId/pull-request/failing-checks/prepare')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'prepareRunFailingChecks' })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run has no pull request (${EXECUTIONS_PROBLEM_TYPES.pullRequestNotRefreshable}) or no failed check (${EXECUTIONS_PROBLEM_TYPES.noFailingChecks})`,
  })
  async prepare(@Param('runId') runId: string) {
    try {
      await this.handler.execute({
        runId,
      });
      const { run, followUp, merge, latestMergeApproval, integrationBranch } =
        await this.getRun.execute({
          runId,
        });
      return toRunResponse(run, followUp, merge, latestMergeApproval, integrationBranch);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PullRequestNotRefreshableError) throw pullRequestNotRefreshable();
      if (error instanceof NoFailingChecksError) throw noFailingChecks();
      throw error;
    }
  }
}
