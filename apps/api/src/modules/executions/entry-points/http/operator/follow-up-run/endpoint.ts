import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import {
  ApiProblemResponses,
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  EXECUTIONS_PROBLEM_TYPES,
  followUpNotAllowed,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse } from '../../shared/run-response.js';
import { FollowUpNotAllowedError } from '../../../../domain/entities/run.js';
import { RunNotFoundError } from '../../../../domain/repositories/run-repository.js';
import { ReviewCommentsNotLoadedError } from '../../../../domain/entities/review-comments.js';
import { FollowUpRunHandler } from '../../../../application/features/follow-up-run/handler.js';
import { followUpRunRequestSchema, FollowUpRunRequestDto } from './schema.js';

/**
 * `POST /api/runs/:runId/follow-up` (Issue #141), behind the global session and mutation Origin
 * guards: 202 with the Run, queued for the Follow-up, once it is stored; 404 for an unknown Run;
 * 409 when the Run cannot take a Follow-up now (still working or waiting, one already queued,
 * Working copy removed, no agent session, Run step total reached, Provider or agent worker
 * unavailable), the detail saying why; 422 for an empty or too long text. The body is typed
 * `unknown`, so the global pipe leaves it alone and an invalid body becomes a 422 here. Issue #146:
 * a 422 also answers selected Review comments that are not (all) in the Run's loaded set.
 */
@ApiTags('runs')
@Controller('runs')
export class FollowUpRunEndpoint {
  constructor(private readonly handler: FollowUpRunHandler) {}

  @Post(':runId/follow-up')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'followUpRun' })
  @ApiBody({ type: FollowUpRunRequestDto })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run cannot take a Follow-up now (${EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed})`,
    422: 'Invalid request body (field errors)',
  })
  async followUp(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = followUpRunRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      const { run, followUp, workerConnected } = await this.handler.execute(
        runId,
        parsed.data.text,
        parsed.data.source,
        parsed.data.reviewCommentIds,
      );
      return toRunResponse(run, followUp, workerConnected);
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof FollowUpNotAllowedError) throw followUpNotAllowed(error.reason);
      if (error instanceof ReviewCommentsNotLoadedError) {
        throw new FieldProblemException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'The selected review comments are not loaded. Load them again.',
          [
            {
              path: 'reviewCommentIds',
              message: 'Some selected comments are not in the loaded set.',
            },
          ],
        );
      }
      throw error;
    }
  }
}
