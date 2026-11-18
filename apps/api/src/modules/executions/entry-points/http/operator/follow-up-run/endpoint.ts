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
  followUpNotAllowed,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import { FollowUpNotAllowedError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { ReviewCommentsNotLoadedError } from '../../../../domain/errors/run-errors.js';
import { FollowUpRunHandler } from '../../../../application/features/follow-up-run/handler.js';
import { followUpRunRequestSchema, FollowUpRunRequestDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class FollowUpRunEndpoint {
  constructor(private readonly handler: FollowUpRunHandler) {}

  @Post(':runId/follow-up')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'followUpRun' })
  @ApiBody({ type: FollowUpRunRequestDto })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run cannot take a Follow-up now (${EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed})`,
    422: 'Invalid request body (field errors)',
  })
  async followUp(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = followUpRunRequestSchema.safeParse(body);
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
        text: parsed.data.text,
        ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
        ...(parsed.data.reviewCommentIds === undefined
          ? {}
          : { reviewCommentIds: parsed.data.reviewCommentIds }),
      });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp), followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof FollowUpNotAllowedError) throw followUpNotAllowed(error.reason);
      if (error instanceof ReviewCommentsNotLoadedError) {
        throw new FieldProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The selected review comments are not loaded. Load them again.',
          [
            {
              path: 'reviewCommentIds',
              message: 'Some selected comments are not in the loaded set.',
            },
          ],
        );
      }
      throw error;
    }
  }
}
