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
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import { PullRequestNotRefreshableError } from '../../../../domain/value-objects/run-lookup.js';
import {
  NoFailingChecksError,
  PrepareFailingChecksHandler,
} from '../../../../application/features/prepare-failing-checks/handler.js';

/**
 * `POST /api/runs/:runId/pull-request/failing-checks/prepare` (Issue #145), behind the global
 * session and mutation Origin guards: 202 with the Run, marked as preparing while an agent worker
 * reads the logs of the failed checks (a second request while one is under way is that one); 404
 * for an unknown Run; 409 for a Run without a pull request, or none of whose checks is known to
 * have failed. No body. Nothing is sent to an agent.
 */
@ApiTags('runs')
@Controller('runs')
export class PrepareFailingChecksEndpoint {
  constructor(private readonly handler: PrepareFailingChecksHandler) {}

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
      const { run, followUp, workerConnected } = await this.handler.execute(runId);
      return toRunResponse(run, followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof PullRequestNotRefreshableError) throw pullRequestNotRefreshable();
      if (error instanceof NoFailingChecksError) throw noFailingChecks();
      throw error;
    }
  }
}
