import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import { EXECUTIONS_PROBLEM_TYPES, runNotFound, runNotWaiting } from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import { RunNotWaitingError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { AnswerRunHandler } from '../../../../application/features/answer-run/handler.js';
import { answerRunRequestSchema, AnswerRunRequestDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class AnswerRunEndpoint {
  constructor(private readonly handler: AnswerRunHandler) {}

  @Post(':runId/answer')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'answerRun' })
  @ApiBody({ type: AnswerRunRequestDto })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run is not waiting for an answer (${EXECUTIONS_PROBLEM_TYPES.runNotWaiting})`,
    422: 'Invalid request body (field errors)',
  })
  async answer(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = answerRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      const { run, preparedFollowUp } = await this.handler.execute({
        runId,
        text: parsed.data.text,
      });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotWaitingError) throw runNotWaiting(error.state);
      throw error;
    }
  }
}
