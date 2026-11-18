import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
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
  @ApiAcceptedResponse({ description: 'The Follow-up is accepted.' })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run cannot take a Follow-up now (${EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed})`,
    422: 'Invalid request body (field errors)',
  })
  async followUp(@Param('runId') runId: string, @Body() body: unknown): Promise<void> {
    const parsed = followUpRunRequestSchema.safeParse(body);
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
        text: parsed.data.text,
        ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
        ...(parsed.data.reviewCommentIds === undefined
          ? {}
          : { reviewCommentIds: parsed.data.reviewCommentIds }),
      });
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
