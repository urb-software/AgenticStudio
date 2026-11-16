import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { runNotFound, runNotHeld } from '../../contracts/http/problems.js';
import { RunNotFoundError, RunNotHeldError } from '../../domain/repositories/run-repository.js';
import { ReportRunDiffHandler } from './handler.js';
import { ReportRunDiffRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/:runId/diff` (Issue #144), worker token only: 204 once the Run's diffs
 * replace the stored ones, 404 for an unknown Run, 409 unless this worker holds it. Its body
 * may be up to `RUN_DIFF_REQUEST_MAX_BYTES` (the app's body parser for this route).
 */
@WorkerController('runs')
export class ReportRunDiffEndpoint {
  constructor(private readonly handler: ReportRunDiffHandler) {}

  @Post(':runId/diff')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Param('runId') runId: string, @Body() body: ReportRunDiffRequestDto) {
    try {
      await this.handler.execute({
        runId,
        workerId: body.workerId,
        diffs:
          body.unavailable !== undefined
            ? { unavailable: body.unavailable }
            : { run: body.run!, last: body.last!, state: body.state! },
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      throw error;
    }
  }
}
