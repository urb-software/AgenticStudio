import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  closeInProgress,
  closePullRequestRefused,
  EXECUTIONS_PROBLEM_TYPES,
  runNotFound,
} from '../../shared/problems.js';
import {
  CloseInProgressError,
  ClosePullRequestRefusedError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { ClosePullRequestHandler } from '../../../../application/features/close-pull-request/handler.js';
import { ClosePullRequestResponseDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class ClosePullRequestEndpoint {
  constructor(private readonly handler: ClosePullRequestHandler) {}

  @Post(':runId/pull-request/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: 'closeRunPullRequest' })
  @ZodResponse({ status: 200, type: ClosePullRequestResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409:
      `Refused: ${EXECUTIONS_PROBLEM_TYPES.closeRunActive}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.closePullRequestNotOpen}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.closeMergeUnavailable}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.closeHostRefused} or ` +
      `${EXECUTIONS_PROBLEM_TYPES.closeInProgress}`,
  })
  async close(@Param('runId') runId: string) {
    try {
      const result = await this.handler.execute({ runId });
      return {
        state: result.state,
        closedFromStudioAt: result.closedFromStudioAt.toISOString(),
        ...(result.runBranchDeletedAt
          ? { runBranchDeletedAt: result.runBranchDeletedAt.toISOString() }
          : {}),
        ...(result.runBranchDeletionFailure
          ? { runBranchDeletionFailure: result.runBranchDeletionFailure }
          : {}),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof ClosePullRequestRefusedError) {
        throw closePullRequestRefused(error.reason, error.detail);
      }
      if (error instanceof CloseInProgressError) throw closeInProgress();
      throw error;
    }
  }
}
