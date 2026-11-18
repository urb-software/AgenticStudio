import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
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
import { FollowUpNotAllowedError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { FollowUpRunHandler } from '../../../../application/features/follow-up-run/handler.js';
import { bringUpToDateRequestSchema, BringUpToDateRequestDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class BringUpToDateEndpoint {
  constructor(private readonly handler: FollowUpRunHandler) {}

  @Post(':runId/bring-up-to-date')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'bringUpToDateRun' })
  @ApiBody({ type: BringUpToDateRequestDto, required: false })
  @ApiAcceptedResponse({ description: 'The Follow-up is accepted.' })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run cannot take a Follow-up now (${EXECUTIONS_PROBLEM_TYPES.followUpNotAllowed})`,
    422: 'Invalid request body (field errors)',
  })
  async bringUpToDate(@Param('runId') runId: string, @Body() body: unknown): Promise<void> {
    const parsed = bringUpToDateRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      await this.handler.execute({
        runId,
        text: parsed.data.note ?? '',
        source: 'bring_up_to_date',
      });
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof FollowUpNotAllowedError) throw followUpNotAllowed(error.reason);
      throw error;
    }
  }
}
