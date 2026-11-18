import { type RunPayload, runPayloadSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { RunConversation } from '../../../../domain/value-objects/run-conversation.js';
import {
  type ClaimedRun,
  ClaimRunHandler,
} from '../../../../application/features/claim-run/handler.js';
import { ClaimRunRequestDto } from './schema.js';

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
      studioPaths: run.studioPaths,
      // The snapshot goes to the claiming worker only; never logged.
      ...(run.environmentFile ? { environmentFile: run.environmentFile } : {}),
      ...(run.replaceEnvironmentFile ? { replaceEnvironmentFile: true as const } : {}),
      ...kindOf(run),
      limits: { stepMinutes: run.limits.stepMinutes, maxSteps: run.limits.maxSteps },
      completedSteps: run.completedSteps,
      stepsBeforePart: run.stepsBeforePart,
      ...(run.diffState ? { diffState: withRunPushedCommit(run.diffState, run.pushedCommit) } : {}),
    });
  }
}

function updateOf(run: ClaimedRun) {
  const start = RunConversation.of(run.messages).currentUpdateStart();
  return start === undefined ? {} : { bringUpToDate: true as const, ...start };
}

function kindOf(run: ClaimedRun) {
  const pullRequest = run.pullRequest ? { pullRequestNumber: run.pullRequest.number } : {};
  const conversation = RunConversation.of(run.messages);
  const merged = conversation.latestMergedCommit();
  // A delivery retry after a bring-up part counts from the commit it merged, which
  // is not recorded as merged until the part succeeds.
  const counted = conversation.currentUpdateStart()?.updateTip ?? merged;
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
  const resume = conversation.resumeMessage(run.sessionRef !== null);
  if (resume !== null && run.sessionRef !== null) {
    // A merge an earlier bring-up part left behind is undone by the next part.
    const pending = conversation.pendingUpdate(run.pushedCommit);
    return {
      ...mergedBase,
      ...(pending === undefined ? {} : { pendingUpdate: pending }),
      kind: 'resume' as const,
      runBranch: run.workingCopy?.runBranch,
      sessionRef: run.sessionRef,
      answer: resume.text,
      resumeReason: resume.reason,
      ...(run.followUpCount > 0 ? { followUpNumber: run.followUpCount } : {}),
      ...updateOf(run),
      nextSeq: run.nextSeq,
      ...pullRequest,
    };
  }
  return { kind: 'start' as const };
}

/** The pushed commit is the Run's, so the diff's "includes unpushed" is derived from it. */
function withRunPushedCommit(
  state: NonNullable<ClaimedRun['diffState']>,
  pushedCommit: string | null,
): NonNullable<ClaimedRun['diffState']> {
  const { pushedCommit: _stored, ...rest } = state;
  void _stored;
  return pushedCommit === null ? rest : { ...rest, pushedCommit };
}
