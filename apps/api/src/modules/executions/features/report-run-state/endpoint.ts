import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { illegalRunTransition, runNotFound, runNotHeld } from '../../contracts/http/problems.js';
import { IllegalRunTransitionError } from '../../domain/entities/run.js';
import { RunNotFoundError, RunNotHeldError } from '../../domain/repositories/run-repository.js';
import { ReportRunStateHandler } from './handler.js';
import { ReportRunStateRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/:runId/state` (Issue #96), worker token only: 204, 404 for an
 * unknown Run, 409 when this worker does not hold it or the transition is not allowed.
 */
@WorkerController('runs')
export class ReportRunStateEndpoint {
  constructor(private readonly handler: ReportRunStateHandler) {}

  @Post(':runId/state')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Param('runId') runId: string, @Body() body: ReportRunStateRequestDto) {
    try {
      await this.handler.execute({
        runId,
        workerId: body.workerId,
        state: body.state,
        failure: body.failure ?? null,
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      if (error instanceof IllegalRunTransitionError) throw illegalRunTransition(error.message);
      throw error;
    }
  }
}
