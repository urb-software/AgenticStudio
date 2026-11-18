import { type HeartbeatResponse, heartbeatResponseSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { runNotFound, runNotHeld } from '../../shared/problems.js';
import { RunNotHeldError } from '../../../../domain/repositories/run-repository.js';
import { RecordHeartbeatHandler } from '../../../../application/features/record-heartbeat/handler.js';
import { HeartbeatRequestDto } from './schema.js';
import { RunNotFoundError } from '../../../../domain/value-objects/run-errors.js';

/**
 * `POST /api/worker/runs/:runId/heartbeat` (Issue #96), worker token only: 200 with
 * `{ cancelRequested }` (Issue #100), 404 for an unknown Run, 409 when this worker does not
 * hold it (released, swept, or another's).
 */
@WorkerController('runs')
export class RecordHeartbeatEndpoint {
  constructor(private readonly handler: RecordHeartbeatHandler) {}

  @Post(':runId/heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(
    @Param('runId') runId: string,
    @Body() body: HeartbeatRequestDto,
  ): Promise<HeartbeatResponse> {
    try {
      return heartbeatResponseSchema.parse(
        await this.handler.execute({ runId, workerId: body.workerId }),
      );
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotHeldError) throw runNotHeld();
      throw error;
    }
  }
}
