import { type RunPayload, runPayloadSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { ClaimRunHandler } from './handler.js';
import { ClaimRunRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/claim` (Issue #96), worker token only: 200 with the Run payload, or
 * 204 when no Run is eligible. The payload carries what a Run needs and nothing else, and
 * whether the worker starts the Run or only retries its delivery (Issue #102).
 */
@WorkerController('runs')
export class ClaimRunEndpoint {
  constructor(private readonly handler: ClaimRunHandler) {}

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: ClaimRunRequestDto,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<RunPayload | undefined> {
    const run = await this.handler.execute(body.workerId);
    if (!run) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return runPayloadSchema.parse({
      runId: run.id,
      projectId: run.projectId,
      provider: run.provider,
      task: run.task,
      startCommit: run.startCommit,
      repository: { remoteUrl: run.remoteUrl },
      integrationBranch: run.integrationBranch,
      // Issue #102: a failed Run handed out again is a delivery retry, nothing else.
      kind: run.state === 'failed' ? 'deliver' : 'start',
    });
  }
}
