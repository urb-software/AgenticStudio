import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  resumeSlotTaken,
  runNotFound,
  runNotResumable,
} from '../../shared/problems.js';
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
  @ApiAcceptedResponse({ description: 'The resume is accepted.' })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409:
      `The run did not stop at the usage limit with a session (${EXECUTIONS_PROBLEM_TYPES.runNotResumable}), ` +
      `or its project or the server has no free place (${EXECUTIONS_PROBLEM_TYPES.resumeSlotTaken})`,
  })
  async resume(@Param('runId') runId: string): Promise<void> {
    try {
      await this.handler.execute({ runId });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotResumableError) throw runNotResumable();
      if (error instanceof RunSlotTakenError) throw resumeSlotTaken(error.message);
      throw error;
    }
  }
}
