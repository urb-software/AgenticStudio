import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { runNotFound, runNotHeld } from '../../contracts/http/problems.js';
import { RunNotFoundError, RunNotHeldError } from '../../domain/repositories/run-repository.js';
import { RecordHeartbeatHandler } from './handler.js';
import { HeartbeatRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/:runId/heartbeat` (Issue #96), worker token only: 204, 404 for an
 * unknown Run, 409 when this worker does not hold it (released, swept, or another's).
 */
@WorkerController('runs')
export class RecordHeartbeatEndpoint {
  constructor(private readonly handler: RecordHeartbeatHandler) {}

  @Post(':runId/heartbeat')
  @HttpCode(HttpStatus.NO_CONTENT)
  async heartbeat(@Param('runId') runId: string, @Body() body: HeartbeatRequestDto) {
    try {
      await this.handler.execute({ runId, workerId: body.workerId });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      throw error;
    }
  }
}
