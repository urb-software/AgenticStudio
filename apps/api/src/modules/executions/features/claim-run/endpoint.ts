import { type RunPayload, runPayloadSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import { resumeAnswer } from '../../domain/entities/run.js';
import { type ClaimedRun, ClaimRunHandler } from './handler.js';
import { ClaimRunRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/claim` (Issue #96), worker token only: 200 with the Run payload, or
 * 204 when no Run is eligible. The payload carries what a Run needs and nothing else, and
 * whether the worker starts the Run, only retries its delivery (Issue #102) or resumes it with
 * the operator's answer (Issue #103).
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
      // Studio places no files in a Working copy yet; #104 adds the Environment file here.
      studioPaths: [],
      // Issue #102: a failed Run handed out again is a delivery retry, nothing else; it pushes
      // exactly the Run branch Studio recorded (review R1 of #122). Issue #103: an answered Run
      // resumes its agent session with the answer, its events continuing after the stored log.
      ...kindOf(run),
      // The worker enforces these (Issue #100); the waiting period is Studio's own.
      limits: { stepMinutes: run.limits.stepMinutes, maxSteps: run.limits.maxSteps },
      completedSteps: run.completedSteps,
    });
  }
}

/** The kind of a claim and the fields that go with it. */
function kindOf(run: ClaimedRun) {
  if (run.state === 'failed') {
    return { kind: 'deliver' as const, runBranch: run.workingCopy?.runBranch };
  }
  const answer = resumeAnswer(run);
  if (answer !== null && run.sessionRef !== null) {
    return {
      kind: 'resume' as const,
      runBranch: run.workingCopy?.runBranch,
      sessionRef: run.sessionRef,
      answer,
      nextSeq: run.nextSeq,
    };
  }
  return { kind: 'start' as const };
}
