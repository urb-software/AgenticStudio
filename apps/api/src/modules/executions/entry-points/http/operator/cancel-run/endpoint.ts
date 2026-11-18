import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  runAlreadyFinished,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse, withPreparedFollowUp } from '../../shared/run-response.js';
import {
  RunAlreadyFinishedError,
  RunNotFoundError,
} from '../../../../domain/value-objects/run-errors.js';
import { CancelRunHandler } from '../../../../application/features/cancel-run/handler.js';

/**
 * `POST /api/runs/:runId/cancel` (Issue #100), behind the global session and mutation Origin
 * guards: 202 with the Run. A queued or waiting Run is `cancelled` at once; a preparing or
 * running Run carries `cancelRequestedAt` until the agent worker confirms. Repeating it is
 * harmless (202); a finished Run is a 409.
 */
@ApiTags('runs')
@Controller('runs')
export class CancelRunEndpoint {
  constructor(private readonly handler: CancelRunHandler) {}

  @Post(':runId/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'cancelRun' })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run has already finished (${EXECUTIONS_PROBLEM_TYPES.runAlreadyFinished})`,
  })
  async cancel(@Param('runId') runId: string) {
    try {
      const { run, preparedFollowUp } = await this.handler.execute({ runId });
      return toRunResponse(withPreparedFollowUp(run, preparedFollowUp));
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunAlreadyFinishedError) throw runAlreadyFinished(error.state);
      throw error;
    }
  }
}
