import { reportOperationStateRequestSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { EnvironmentControllerEndpoint } from '../../../../../../platform/auth/controller-route.js';
import {
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import { ReportPreviewOperationStateHandler } from '../../../../application/features/report-preview-operation-state/handler.js';
import {
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../../domain/errors/preview-operation-errors.js';
import { operationNotFound, operationNotHeld } from '../../shared/problems.js';

@EnvironmentControllerEndpoint('operations')
export class ReportOperationStateEndpoint {
  constructor(private readonly handler: ReportPreviewOperationStateHandler) {}

  @Post(':operationId/state')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Param('operationId') operationId: string, @Body() body: unknown): Promise<void> {
    const parsed = reportOperationStateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    const { controllerId, state, failure, runtime } = parsed.data;
    try {
      await this.handler.execute({
        operationId,
        controllerId,
        state,
        ...(failure === undefined ? {} : { failure }),
        ...(runtime === undefined ? {} : { runtime }),
      });
    } catch (error) {
      if (error instanceof PreviewOperationNotFoundError) throw operationNotFound();
      if (error instanceof PreviewOperationNotHeldError) throw operationNotHeld();
      throw error;
    }
  }
}
