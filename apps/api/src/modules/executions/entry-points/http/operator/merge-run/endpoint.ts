import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import { MergeRunHandler } from '../../../../application/features/merge-run/handler.js';
import { MergeRefusedError } from '../../../../domain/errors/merge-approval-errors.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { toMergeApprovalResponse } from '../../shared/merge-approval-response.js';
import { EXECUTIONS_PROBLEM_TYPES, mergeRefused, runNotFound } from '../../shared/problems.js';
import { MergeRunRequestDto, MergeRunResponseDto, mergeRunRequestSchema } from './schema.js';

/** Operator-only: the worker token authenticates no route that can start a merge. */
@ApiTags('runs')
@Controller('runs')
export class MergeRunEndpoint {
  constructor(private readonly handler: MergeRunHandler) {}

  @Post(':runId/merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: 'mergeRun' })
  @ApiBody({ type: MergeRunRequestDto })
  @ZodResponse({ status: 200, type: MergeRunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409:
      `Refused: ${EXECUTIONS_PROBLEM_TYPES.mergeChecksFailing}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeChecksRunning}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeConflicting}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeRunActive}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeCommitMoved}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeReviewOutOfDate}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergePullRequestNotOpen}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeUnavailable}, ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeHostRefused} or ` +
      `${EXECUTIONS_PROBLEM_TYPES.mergeInProgress}`,
    422: 'Invalid request body (field errors)',
  })
  async merge(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = mergeRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      const result = await this.handler.execute({ runId, commit: parsed.data.commit });
      return {
        ...toMergeApprovalResponse(result.approval),
        ...(result.runBranchDeletedAt
          ? { runBranchDeletedAt: result.runBranchDeletedAt.toISOString() }
          : {}),
        ...(result.runBranchDeletionFailure
          ? { runBranchDeletionFailure: result.runBranchDeletionFailure }
          : {}),
      };
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof MergeRefusedError) throw mergeRefused(error.reason, error.detail);
      throw error;
    }
  }
}
