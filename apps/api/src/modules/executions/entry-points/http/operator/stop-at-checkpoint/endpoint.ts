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
  runNotAtCheckpoint,
  runNotFound,
} from '../../shared/problems.js';
import { RunResponseDto, toRunResponse } from '../../shared/run-response.js';
import { StopAtCheckpointHandler } from '../../../../application/features/stop-at-checkpoint/handler.js';
import { GetRunHandler } from '../../../../application/features/get-run/handler.js';
import { RunNotAtCheckpointError, RunNotFoundError } from '../../../../domain/errors/run-errors.js';
import { stopAtCheckpointRequestSchema, StopAtCheckpointRequestDto } from './schema.js';

@ApiTags('runs')
@Controller('runs')
export class StopAtCheckpointEndpoint {
  constructor(
    private readonly handler: StopAtCheckpointHandler,
    private readonly getRun: GetRunHandler,
  ) {}

  @Post(':runId/checkpoint/stop')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: 'stopRunAtCheckpoint' })
  @ApiBody({ type: StopAtCheckpointRequestDto, required: false })
  @ZodResponse({ status: 202, type: RunResponseDto })
  @ApiProblemResponses({
    404: `Unknown run (${EXECUTIONS_PROBLEM_TYPES.runNotFound})`,
    409: `The run does not wait at a Checkpoint (${EXECUTIONS_PROBLEM_TYPES.runNotAtCheckpoint}; reason: not_at_checkpoint)`,
    422: 'Invalid request body (field errors)',
  })
  async stop(@Param('runId') runId: string, @Body() body: unknown) {
    const parsed = stopAtCheckpointRequestSchema.safeParse(body ?? {});
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
        ...(parsed.data.checkpoint === undefined ? {} : { checkpoint: parsed.data.checkpoint }),
      });
      const { run, followUp, merge, latestMergeApproval, integrationBranch, previewAfterMerge } =
        await this.getRun.execute({ runId });
      return toRunResponse(
        run,
        followUp,
        merge,
        latestMergeApproval,
        integrationBranch,
        previewAfterMerge,
      );
    } catch (error) {
      if (error instanceof RunNotFoundError) throw runNotFound();
      if (error instanceof RunNotAtCheckpointError) throw runNotAtCheckpoint();
      throw error;
    }
  }
}
