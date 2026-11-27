import { BASE_RULES, type RunPayload, runPayloadSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
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
    // The recorded skill names are not the agent's payload: the skills carry their descriptions.
    const { skills: _recordedSkills, ...agent } = run.agent;
    void _recordedSkills;
    return runPayloadSchema.parse({
      runId: run.id,
      projectId: run.projectId,
      provider: run.provider,
      // Studio's current base rules and the Run's recorded agent: never resolved again.
      baseRules: { version: BASE_RULES.version, text: BASE_RULES.text },
      agent,
      skills: run.skills,
      task: run.task,
      startCommit: run.startCommit,
      repository: { remoteUrl: run.remoteUrl },
      integrationBranch: run.integrationBranch,
      studioPaths: run.studioPaths,
      // The snapshot goes to the claiming worker only; never logged.
      ...(run.environmentFile ? { environmentFile: run.environmentFile } : {}),
      ...(run.replaceEnvironmentFile ? { replaceEnvironmentFile: true as const } : {}),
      ...kindOf(run),
      ...(run.phase === undefined ? {} : { phase: run.phase }),
      limits: { stepMinutes: run.limits.stepMinutes, maxSteps: run.limits.maxSteps },
      completedSteps: run.completedSteps,
      stepsBeforePart: run.stepsBeforePart,
      ...(run.diffState ? { diffState: withRunPushedCommit(run.diffState, run.pushedCommit) } : {}),
    });
  }
}

function kindOf(run: ClaimedRun) {
  const { handOut } = run;
  switch (handOut.kind) {
    case 'start':
      return { kind: 'start' as const };
    case 'deliver':
      return {
        ...(handOut.mergedIntegrationCommit === undefined
          ? {}
          : { mergedIntegrationCommit: handOut.mergedIntegrationCommit }),
        kind: 'deliver' as const,
        runBranch: handOut.runBranch,
        nextSeq: run.nextSeq,
        ...(handOut.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: handOut.pullRequestNumber }),
      };
    case 'next_phase':
      return {
        ...(handOut.mergedIntegrationCommit === undefined
          ? {}
          : { mergedIntegrationCommit: handOut.mergedIntegrationCommit }),
        kind: 'next_phase' as const,
        runBranch: handOut.runBranch,
        ...(handOut.session === undefined
          ? {}
          : {
              sessionRef: handOut.session.sessionRef,
              answer: handOut.session.answer,
              resumeReason: handOut.session.reason,
            }),
        ...(handOut.followUpNumber === undefined ? {} : { followUpNumber: handOut.followUpNumber }),
        nextSeq: run.nextSeq,
        ...(handOut.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: handOut.pullRequestNumber }),
      };
    case 'resume':
      return {
        ...(handOut.mergedIntegrationCommit === undefined
          ? {}
          : { mergedIntegrationCommit: handOut.mergedIntegrationCommit }),
        ...(handOut.pendingUpdate === undefined ? {} : { pendingUpdate: handOut.pendingUpdate }),
        kind: 'resume' as const,
        runBranch: handOut.runBranch,
        sessionRef: handOut.sessionRef,
        answer: handOut.answer,
        resumeReason: handOut.reason,
        ...(handOut.followUpNumber === undefined ? {} : { followUpNumber: handOut.followUpNumber }),
        ...(handOut.bringUpToDate === undefined
          ? {}
          : { bringUpToDate: true as const, ...handOut.bringUpToDate }),
        nextSeq: run.nextSeq,
        ...(handOut.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: handOut.pullRequestNumber }),
      };
  }
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
