import { type ClaimLookupsResponse, claimLookupsResponseSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { WorkerController } from '../../../../../../platform/auth/worker-route.js';
import { ClaimLookupsHandler } from '../../../../application/features/claim-lookups/handler.js';
import { ClaimLookupsRequestDto } from './schema.js';

@WorkerController('lookups')
export class ClaimLookupsEndpoint {
  constructor(private readonly handler: ClaimLookupsHandler) {}

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: ClaimLookupsRequestDto,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<ClaimLookupsResponse | undefined> {
    const { lookups } = await this.handler.execute({ workerId: body.workerId });
    if (lookups.length === 0) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return claimLookupsResponseSchema.parse(
      lookups.map((lookup) => ({
        id: lookup.id,
        kind: lookup.kind,
        runId: lookup.runId,
        repository: { remoteUrl: lookup.remoteUrl },
        pullRequestNumber: lookup.pullRequestNumber,
        runBranch: lookup.runBranch,
        integrationBranch: lookup.integrationBranch,
        ...(lookup.reviewComments === undefined
          ? {}
          : {
              reviewComments: {
                scope: lookup.reviewComments.scope,
                ...(lookup.reviewComments.since === undefined
                  ? {}
                  : { since: lookup.reviewComments.since.toISOString() }),
              },
            }),
      })),
    );
  }
}
