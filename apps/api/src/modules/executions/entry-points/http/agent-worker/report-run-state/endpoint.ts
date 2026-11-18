import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { illegalRunTransition, runNotFound, runNotHeld } from '../../shared/problems.js';
import {
  IllegalRunTransitionError,
  RunNotFoundError,
} from '../../../../domain/errors/run-errors.js';
import { RunNotHeldError } from '../../../../domain/repositories/run-repository.js';
import { ReportRunStateHandler } from '../../../../application/features/report-run-state/handler.js';
import { ReportRunStateRequestDto } from './schema.js';

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
        workingCopy: body.workingCopy ?? null,
        delivery: body.delivery ?? null,
        sessionRef: body.sessionRef ?? null,
        pushedCommit: body.pushedCommit ?? null,
        pullRequestState: body.pullRequestState ?? null,
        bringUpToDateStarted: body.bringUpToDateStarted ?? null,
        unchanged: body.unchanged === true,
        unchangedDetail: body.unchangedDetail ?? null,
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      if (error instanceof IllegalRunTransitionError) throw illegalRunTransition(error.message);
      throw error;
    }
  }
}
