import { type RunStatesResponse, runStatesResponseSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { GetRunStatesHandler } from './handler.js';
import { RunStatesRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/states` (Issue #98), worker token only: 200 with the state of each
 * asked Run that exists and, for a final one, when it finished. Feeds the agent worker's
 * Working copy retention; changes nothing.
 */
@WorkerController('runs')
export class GetRunStatesEndpoint {
  constructor(private readonly handler: GetRunStatesHandler) {}

  @Post('states')
  @HttpCode(HttpStatus.OK)
  async states(@Body() body: RunStatesRequestDto): Promise<RunStatesResponse> {
    const states = await this.handler.execute(body.runIds);
    return runStatesResponseSchema.parse(
      states.map((run) => ({
        runId: run.runId,
        state: run.state,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      })),
    );
  }
}
