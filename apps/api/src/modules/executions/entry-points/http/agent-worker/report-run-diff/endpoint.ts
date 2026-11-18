import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { runNotFound, runNotHeld } from '../../shared/problems.js';
import { RunNotHeldError } from '../../../../domain/repositories/run-repository.js';
import { ReportRunDiffHandler } from '../../../../application/features/report-run-diff/handler.js';
import { ReportRunDiffRequestDto } from './schema.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

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
