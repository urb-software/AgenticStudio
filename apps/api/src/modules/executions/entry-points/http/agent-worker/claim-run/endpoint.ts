import { type RunPayload, runPayloadSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import {
  currentUpdateStart,
  latestMergedCommit,
  pendingUpdate,
  resumeMessage,
} from '../../../../domain/entities/run.js';
import {
  type ClaimedRun,
  ClaimRunHandler,
} from '../../../../application/features/claim-run/handler.js';
import { ClaimRunRequestDto } from './schema.js';

/**
 * `POST /api/worker/runs/claim` (Issue #96), worker token only: 200 with the Run payload, or
 * 204 when no Run is eligible. The payload carries what a Run needs and nothing else, and
 * whether the worker starts the Run, only retries its delivery (Issue #102) or resumes it with
 * the operator's answer (Issue #103). The Project's Environment file (Issue #104) is the one
 * secret value in it, in a start claim only.
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
    const run = await this.handler.execute({ workerId: body.workerId });
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
      // Review S3 of #150: a Follow-up's claim lists the earlier path too, which the worker removes.
      studioPaths: run.studioPaths,
      // Issue #104: the snapshot, to the claiming worker only, when it starts the Run (or, review
      // S3 of #150, takes a new one for a Follow-up); never logged.
      ...(run.environmentFile ? { environmentFile: run.environmentFile } : {}),
      ...(run.replaceEnvironmentFile ? { replaceEnvironmentFile: true as const } : {}),
      // Issue #102: a failed Run handed out again is a delivery retry, nothing else; it pushes
      // exactly the Run branch Studio recorded (review R1 of #122). Issue #103: an answered Run
      // resumes its agent session with the answer, its events continuing after the stored log.
      ...kindOf(run),
      // The worker enforces these (Issue #100); the waiting period is Studio's own.
      limits: { stepMinutes: run.limits.stepMinutes, maxSteps: run.limits.maxSteps },
      completedSteps: run.completedSteps,
      // Issue #141: each part of the Run (the first, or a Follow-up) gets its own allowance.
      stepsBeforePart: run.stepsBeforePart,
      // Issue #144: where the Run's diffs stand, back to the worker that resumes or delivers it.
      // The pushed commit has one source of truth, the Run's (#141): the diff state carries it.
      ...(run.diffState ? { diffState: withRunPushedCommit(run.diffState, run.pushedCommit) } : {}),
    });
  }
}

/**
 * Issue #147: while the Run's current part is a request to bring the Run branch up to date, the
 * flag and, once the worker reported the merge's start, where it started (so every later claim of
 * the part can reset the branch or expect the merge).
 */
function updateOf(run: ClaimedRun) {
  const start = currentUpdateStart(run);
  return start === undefined ? {} : { bringUpToDate: true as const, ...start };
}

/** The kind of a claim and the fields that go with it. */
function kindOf(run: ClaimedRun) {
  // Issue #141: a delivery updates the Run's one pull request, never opens a second.
  const pullRequest = run.pullRequest ? { pullRequestNumber: run.pullRequest.number } : {};
  // Issue #147 (review S1 of #154): the Run's own changes are counted from the integration branch
  // commit it last merged.
  const merged = latestMergedCommit(run);
  // Review R2-4: a delivery retry after a bring-up part counts from the commit it merged, which
  // is not recorded as merged until the part succeeds.
  const counted = currentUpdateStart(run)?.updateTip ?? merged;
  const mergedBase = counted === undefined ? {} : { mergedIntegrationCommit: counted };
  if (run.state === 'failed') {
    return {
      ...mergedBase,
      kind: 'deliver' as const,
      runBranch: run.workingCopy?.runBranch,
      nextSeq: run.nextSeq,
      ...pullRequest,
    };
  }
  const resume = resumeMessage(run);
  if (resume !== null && run.sessionRef !== null) {
    // Review R2-1: a merge an earlier bring-up part left behind is undone by the next part.
    const pending = pendingUpdate(run);
    return {
      ...mergedBase,
      ...(pending === undefined ? {} : { pendingUpdate: pending }),
      kind: 'resume' as const,
      runBranch: run.workingCopy?.runBranch,
      sessionRef: run.sessionRef,
      answer: resume.text,
      resumeReason: resume.reason,
      // Issue #141: while the Run works on a Follow-up, its number (the log marks its start and end).
      ...(run.followUpCount > 0 ? { followUpNumber: run.followUpCount } : {}),
      // Issue #147: the part is a request to bring the Run branch up to date (a merge left open
      // at its end is completed or aborted by the worker).
      ...updateOf(run),
      nextSeq: run.nextSeq,
      ...pullRequest,
    };
  }
  return { kind: 'start' as const };
}

/**
 * The diff state with the Run's pushed commit (#141 and #144 merged): Studio records the pushed
 * commit on the Run, and the diff's "includes unpushed" is derived from that same value.
 */
function withRunPushedCommit(
  state: NonNullable<ClaimedRun['diffState']>,
  pushedCommit: string | null,
): NonNullable<ClaimedRun['diffState']> {
  const { pushedCommit: _stored, ...rest } = state;
  void _stored;
  return pushedCommit === null ? rest : { ...rest, pushedCommit };
}
