import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  runNotFound,
  runNotResumable,
} from '../../contracts/http/problems.js';
import { RunResponseDto, toRunResponse } from '../../contracts/http/run-response.js';
import { RunNotResumableError } from '../../domain/entities/run.js';
import { RunNotFoundError } from '../../domain/repositories/run-repository.js';
import { ResumeRunHandler } from './handler.js';

/**
 * `POST /api/runs/:runId/resume` (Issue #105), behind the global session and mutation Origin
 * guards: 202 with the Run, queued to resume its agent session, once the request is stored; 404
 * for an unknown Run; 409 unless the Run stopped at the usage limit with a session to resume.
 */
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
    409: `The run did not stop at the usage limit with a session (${EXECUTIONS_PROBLEM_TYPES.runNotResumable})`,
  })
  async resume(@Param('runId') runId: string) {
    try {
      return toRunResponse(await this.handler.execute(runId));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotResumableError) throw runNotResumable();
      throw error;
    }
  }
}
