import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../contracts/http/problems.js';
import {
  ReviewCommentsResponseDto,
  toReviewCommentsResponse,
} from '../../contracts/http/review-comments-response.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { GetReviewCommentsHandler } from './handler.js';

/**
 * `GET /api/runs/:runId/pull-request/review-comments` (Issue #146), behind the global session
 * guard: the Review comments loaded for the Run, with the operator's configured login, whether
 * each is by the operator, and the state of the latest load; 404 for an unknown Run. Reading it
 * starts no load and sends nothing to an agent.
 */
@ApiTags('runs')
@Controller('runs')
export class GetReviewCommentsEndpoint {
  constructor(private readonly handler: GetReviewCommentsHandler) {}

  @Get(':runId/pull-request/review-comments')
  @ApiOperation({ operationId: 'getRunReviewComments' })
  @ZodResponse({ status: 200, type: ReviewCommentsResponseDto })
  @ApiProblemResponses({ 404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})` })
  async get(@Param('runId') runId: string) {
    try {
      return toReviewCommentsResponse(await this.handler.execute(runId));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
