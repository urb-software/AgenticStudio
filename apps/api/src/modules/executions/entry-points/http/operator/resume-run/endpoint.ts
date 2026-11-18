import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  resumeSlotTaken,
  runNotFound,
  runNotResumable,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import {
  RunNotResumableError,
  RunSlotTakenError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { ResumeRunHandler } from '../../../../application/features/resume-run/handler.js';

@ApiTags('runs')
@Controller('runs')
export class ResumeRunEndpoint {
  constructor(private readonly handler: ResumeRunHandler) {}

  @Post(':runId/resume')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'resumeRun' })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409:
      `The run did not stop at the usage limit with a session (${EXECUTIONS_PROBLEM_TYPES.runNotResumable}), ` +
      `or its project or the server has no free place (${EXECUTIONS_PROBLEM_TYPES.resumeSlotTaken})`,
  })
  async resume(@Param('runId') runId: string) {
    try {
      const { run, preparedFollowUp } = await this.handler.execute({ runId });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotResumableError) throw runNotResumable();
      if (error instanceof RunSlotTakenError) throw resumeSlotTaken(error.message);
      throw error;
    }
  }
}
