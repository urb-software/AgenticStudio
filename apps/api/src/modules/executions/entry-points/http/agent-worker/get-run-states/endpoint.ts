import { type RunStatesResponse, runStatesResponseSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { GetRunStatesHandler } from '../../../../application/features/get-run-states/handler.js';
import { RunStatesRequestDto } from './schema.js';

@WorkerController('runs')
export class GetRunStatesEndpoint {
  constructor(private readonly handler: GetRunStatesHandler) {}

  @Post('states')
  @HttpCode(HttpStatus.OK)
  async states(@Body() body: RunStatesRequestDto): Promise<RunStatesResponse> {
    const states = await this.handler.execute({
      runIds: body.runIds,
      ...(body.removedRunIds
        ? { removed: { workerId: body.workerId, runIds: body.removedRunIds } }
        : {}),
    });
    return runStatesResponseSchema.parse(
      states.map((run) => ({
        runId: run.runId,
        state: run.state,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        ...(run.keepUntil ? { keepUntil: run.keepUntil.toISOString() } : {}),
        ...(run.removable ? { removable: true } : {}),
        ...(run.session ? { session: run.session } : {}),
      })),
    );
  }
}
