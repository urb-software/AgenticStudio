import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import {
  runNotFound,
  runNotHeld,
  stepLimitReached,
  stepOutOfOrder,
} from '../../shared/problems.js';
import {
  RunNotHeldError,
  StepLimitReachedError,
  StepOutOfOrderError,
} from '../../../../domain/repositories/run-repository.js';
import { ReportRunStepHandler } from '../../../../application/features/report-run-step/handler.js';
import { ReportRunStepRequestDto } from './schema.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

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
