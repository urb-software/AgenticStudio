import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { runNotFound, runNotHeld } from '../../contracts/http/problems.js';
import { RunNotFoundError, RunNotHeldError } from '../../domain/repositories/run-repository.js';
import { ReportRunStepHandler } from './handler.js';
import { ReportRunStepRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/:runId/steps` (Issue #96), worker token only: 204 once the step's
 * structured result is stored, 404 for an unknown Run, 409 unless this worker holds it running.
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
        kind: body.kind,
        result: body.result,
        workingCopy: body.workingCopy,
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      throw error;
    }
  }
}
