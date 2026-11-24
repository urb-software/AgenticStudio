import {
  type AppendOperationLogResponse,
  appendOperationLogRequestSchema,
  appendOperationLogResponseSchema,
} from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { EnvironmentControllerEndpoint } from '../../../../../../platform/auth/controller-route.js';
import {
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import { AppendPreviewOperationLogHandler } from '../../../../application/features/append-preview-operation-log/handler.js';
import {
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../../domain/errors/preview-operation-errors.js';
import { operationNotFound, operationNotHeld } from '../../shared/problems.js';

@EnvironmentControllerEndpoint('operations')
export class AppendOperationLogEndpoint {
  constructor(private readonly handler: AppendPreviewOperationLogHandler) {}

  @Post(':operationId/log')
  @HttpCode(HttpStatus.OK)
  async append(
    @Param('operationId') operationId: string,
    @Body() body: unknown,
  ): Promise<AppendOperationLogResponse> {
    const parsed = appendOperationLogRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    try {
      return appendOperationLogResponseSchema.parse(
        await this.handler.execute({
          operationId,
          controllerId: parsed.data.controllerId,
          lines: parsed.data.lines.map((line) => ({
            seq: line.seq,
            at: new Date(line.at),
            stream: line.stream,
            text: line.text,
            ...(line.truncated === undefined ? {} : { truncated: line.truncated }),
          })),
        }),
      );
    } catch (error) {
      if (error instanceof PreviewOperationNotFoundError) throw operationNotFound();
      if (error instanceof PreviewOperationNotHeldError) throw operationNotHeld();
      throw error;
    }
  }
}
