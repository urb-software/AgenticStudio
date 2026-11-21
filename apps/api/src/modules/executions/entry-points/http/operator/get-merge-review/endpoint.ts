import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { GetMergeReviewFileHandler } from '../../../../application/features/get-merge-review-file/handler.js';
import { GetMergeReviewHandler } from '../../../../application/features/get-merge-review/handler.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { MergeReviewFileNotFoundError } from '../../../../domain/errors/run-merge-review-errors.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  mergeReviewFileNotFound,
  runNotFound,
} from '../../shared/problems.js';
import { GetMergeReviewFileQueryDto, MergeReviewDto, MergeReviewFileDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class GetMergeReviewEndpoint {
  constructor(
    private readonly reviewHandler: GetMergeReviewHandler,
    private readonly fileHandler: GetMergeReviewFileHandler,
  ) {}

  @Get(':runId/merge-review')
  @ApiOperation({ operationId: 'getRunMergeReview' })
  @ZodResponse({ status: 200, type: MergeReviewDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
  })
  async review(@Param('runId') runId: string) {
    try {
      return await this.reviewHandler.execute({ runId });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      throw error;
    }
  }

  @Get(':runId/merge-review/file')
  @ApiOperation({ operationId: 'getRunMergeReviewFile' })
  @ZodResponse({ status: 200, type: MergeReviewFileDto })
  @ApiProblemResponses({
    400: 'Invalid path',
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound}) or file not in the review (${EXECUTIONS_PROBLEM_TYPES.mergeReviewFileNotFound})`,
  })
  async file(@Param('runId') runId: string, @Query() query: GetMergeReviewFileQueryDto) {
    try {
      return await this.fileHandler.execute({ runId, path: query.path });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof MergeReviewFileNotFoundError) throw mergeReviewFileNotFound();
      throw error;
    }
  }
}
