import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { runNotFound, runNotHeld } from '../../shared/problems.js';
import { RunNotHeldError } from '../../../../domain/repositories/run-repository.js';
import { AppendRunEventsHandler } from '../../../../application/features/append-run-events/handler.js';
import { AppendRunEventsRequestDto } from './schema.js';
import { RunNotFoundError } from '../../../../domain/errors/run-errors.js';

@WorkerController('runs')
export class AppendRunEventsEndpoint {
  constructor(private readonly handler: AppendRunEventsHandler) {}

  @Post(':runId/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  async append(@Param('runId') runId: string, @Body() body: AppendRunEventsRequestDto) {
    try {
      await this.handler.execute({ runId, workerId: body.workerId, events: body.events });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      throw error;
    }
  }
}
