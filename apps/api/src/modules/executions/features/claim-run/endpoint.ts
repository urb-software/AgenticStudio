import { type RunPayload, runPayloadSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { ClaimRunHandler } from './handler.js';
import { ClaimRunRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/claim` (Issue #96), worker token only: 200 with the Run payload, or
 * 204 when no Run is eligible. The payload carries what a Run needs and nothing else, and
 * whether the worker starts the Run or only retries its delivery (Issue #102). The Project's
 * Environment file (Issue #104) is the one secret value in it, in a start claim only.
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
      // The Environment file's path (Issue #104), recorded at the start claim: delivery never
      // commits or pushes it, in a retry too.
      studioPaths: run.environmentFilePath ? [run.environmentFilePath] : [],
      // Issue #104: the snapshot, to the claiming worker only, when it starts the Run; never logged.
      ...(run.environmentFile ? { environmentFile: run.environmentFile } : {}),
      // Issue #102: a failed Run handed out again is a delivery retry, nothing else; it pushes
      // exactly the Run branch Studio recorded (review R1 of #122).
      ...(run.state === 'failed'
        ? { kind: 'deliver', runBranch: run.workingCopy?.runBranch }
        : { kind: 'start' }),
      // The worker enforces these (Issue #100); the waiting period is Studio's own.
      limits: { stepMinutes: run.limits.stepMinutes, maxSteps: run.limits.maxSteps },
      // A start claim hands out a queued Run, which has taken no Run step yet (resumed Runs:
      // #103); a delivery retry starts none.
      completedSteps: run.state === 'failed' ? 1 : 0,
    });
  }
}
