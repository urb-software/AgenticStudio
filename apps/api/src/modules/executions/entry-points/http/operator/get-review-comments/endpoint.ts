import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound } from '../../shared/problems.js';
import {
  ReviewCommentsResponseDto,
  toReviewCommentsResponse,
} from '../../shared/review-comments-response.js';
import { GetReviewCommentsHandler } from '../../../../application/features/get-review-comments/handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

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
      return toReviewCommentsResponse(await this.handler.execute({ runId }));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }
}
