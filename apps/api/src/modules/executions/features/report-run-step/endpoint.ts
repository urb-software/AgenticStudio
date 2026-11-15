import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import {
  runNotFound,
  runNotHeld,
  stepLimitReached,
  stepOutOfOrder,
} from '../../contracts/http/problems.js';
import {
  RunNotFoundError,
  RunNotHeldError,
  StepLimitReachedError,
  StepOutOfOrderError,
} from '../../domain/repositories/run-repository.js';
import { ReportRunStepHandler } from './handler.js';
import { ReportRunStepRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/:runId/steps` (Issue #96), worker token only: 204 once the step's
 * structured result is stored, 404 for an unknown Run, 409 unless this worker holds it running,
 * and 409 (`step-limit-reached`) for a step beyond the Run's maximum, which fails it (#100).
 */
@WorkerController('runs')
export class ReportRunStepEndpoint {
  constructor(private readonly handler: ReportRunStepHandler) {}

  @Post(':runId/steps')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Param('runId') runId: string, @Body() body: ReportRunStepRequestDto) {
    try {
      await this.handler.execute({
        runId,
        workerId: body.workerId,
        index: body.index,
        kind: body.kind,
        result: body.result,
        workingCopy: body.workingCopy,
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      if (error instanceof StepLimitReachedError) throw stepLimitReached();
      if (error instanceof StepOutOfOrderError) throw stepOutOfOrder(error.expected);
      throw error;
    }
  }
}
