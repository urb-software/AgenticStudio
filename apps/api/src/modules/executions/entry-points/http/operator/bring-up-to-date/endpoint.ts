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
import { RunResponseDto, toRunResponse } from '../../shared/run-response.js';
import { FollowUpNotAllowedError } from '../../../../domain/entities/run.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import { BringUpToDateHandler } from '../../../../application/features/bring-up-to-date/handler.js';
import { bringUpToDateRequestSchema, BringUpToDateRequestDto } from './schema.js';

/**
 * `POST /api/runs/:runId/bring-up-to-date` (Issue #147), behind the global session and mutation
 * Origin guards: 202 with the Run, queued for the update, once it is stored; 404 for an unknown
 * Run; 409 when the Run cannot take a Follow-up now (the same reasons, the detail saying why);
 * 422 for a note that is too long. The body is optional and typed `unknown`, so the global pipe
 * leaves it alone and an invalid body becomes a 422 here.
 */
@ApiTags('runs')
@Controller('runs')
export class BringUpToDateEndpoint {
  constructor(private readonly handler: BringUpToDateHandler) {}

  @Post(':runId/bring-up-to-date')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'bringUpToDateRun' })
  @ApiBody({ type: BringUpToDateRequestDto, required: false })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run cannot take a Follow-up now (${EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed})`,
    422: 'Invalid request body (field errors)',
  })
  async bringUpToDate(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = bringUpToDateRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      const { run, followUp, workerConnected } = await this.handler.execute(
        runId,
        parsed.data.note,
      );
      return toRunResponse(run, followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof FollowUpNotAllowedError) throw followUpNotAllowed(error.reason);
      throw error;
    }
  }
}
