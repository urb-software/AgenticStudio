import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { ApiProblemResponses } from '../../../../../../platform/http/problem-details.js';
import { PublishAgentDraftHandler } from '../../../../application/features/publish-agent-draft/handler.js';
import { AGENTS_PROBLEM_TYPES } from '../../shared/problems.js';
import { toPublishHttpError } from '../../shared/publish-http-error.js';
import { PublishAgentDraftRequestDto, PublishAgentDraftResponseDto } from './schema.js';

/**
 * `POST /api/agents/definitions-repository/draft/publish`, behind the global session and mutation
 * Origin guards: an operator route only. No worker or controller token reaches it.
 */
@ApiTags('agents')
@Controller('agents')
export class PublishAgentDraftEndpoint {
  constructor(private readonly handler: PublishAgentDraftHandler) {}

  @Post('definitions-repository/draft/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'publishAgentDraft',
    description:
      "Publishes the Draft as one commit on the definitions Repository's Integration branch: the " +
      "first write Studio makes to a Repository. The commit is built on the Draft's base commit " +
      'and pushed as a fast-forward, never forced; author and committer are the identity set in ' +
      "Studio's settings, never the request's. `version` and `baseCommit` must still be the " +
      "Draft's, the Repository must still hold the base commit, and any problem of the Draft " +
      'blocks the publish. One publish runs at a time. On success the Draft is discarded, the ' +
      "Clone's Integration branch is the new commit and the agents list reads it; a Run already " +
      'started keeps its own commit. A refused publish leaves the Draft as it was.',
  })
  @ZodResponse({ status: 200, type: PublishAgentDraftResponseDto })
  @ApiProblemResponses({
    400: 'Invalid body or message',
    409:
      `The Draft changed since the page read it (${AGENTS_PROBLEM_TYPES.draftConflict}), the Repository ` +
      `moved on (${AGENTS_PROBLEM_TYPES.repositoryMoved}), the Draft changes nothing ` +
      `(${AGENTS_PROBLEM_TYPES.nothingToPublish}), another publish is running ` +
      `(${AGENTS_PROBLEM_TYPES.publishRunning}), the Git host refused the write ` +
      `(${AGENTS_PROBLEM_TYPES.writeRefused}), or the Draft base is gone ` +
      `(${AGENTS_PROBLEM_TYPES.draftBaseMissing}, ${AGENTS_PROBLEM_TYPES.draftNoBase})`,
    422: `The Draft has problems; the \`problems\` member lists each (${AGENTS_PROBLEM_TYPES.publishProblems})`,
    502: `The push failed for another reason (${AGENTS_PROBLEM_TYPES.publishFailed})`,
    503:
      `The commit identity is not configured (${AGENTS_PROBLEM_TYPES.publishNotConfigured}) or the ` +
      `Clone cannot be read now (${AGENTS_PROBLEM_TYPES.agentFilesUnreadable})`,
  })
  async publish(@Body() body: PublishAgentDraftRequestDto) {
    try {
      return await this.handler.execute({
        message: body.message,
        baseCommit: body.baseCommit,
        version: body.version,
      });
    } catch (error) {
      throw toPublishHttpError(error);
    }
  }
}
