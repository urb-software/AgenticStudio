import {
  claimOperationRequestSchema,
  type OperationPayload,
  operationPayloadSchema,
} from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import { EnvironmentControllerEndpoint } from '../../../../../../platform/auth/controller-route.js';
import {
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  type ClaimedPreviewOperation,
  ClaimPreviewOperationHandler,
} from '../../../../application/features/claim-preview-operation/handler.js';

@EnvironmentControllerEndpoint('operations')
export class ClaimOperationEndpoint {
  constructor(private readonly handler: ClaimPreviewOperationHandler) {}

  /** 200 with the claimed operation, 204 when there is nothing to do. */
  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<OperationPayload | undefined> {
    const parsed = claimOperationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    const operation = await this.handler.execute({ controllerId: parsed.data.controllerId });
    if (operation === null) {
      response.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return payloadOf(operation);
  }
}

function payloadOf(operation: ClaimedPreviewOperation): OperationPayload {
  const base = {
    operationId: operation.id,
    projectId: operation.projectId,
    composeProject: operation.composeProject,
    previewLabel: operation.previewLabel,
  };
  if (operation.kind !== 'build' || operation.build === null) {
    return operationPayloadSchema.parse({ ...base, kind: operation.kind });
  }
  // The Environment file goes to the claiming controller only; never logged.
  return operationPayloadSchema.parse({
    ...base,
    kind: 'build',
    ...operation.build,
    environmentFile: operation.environmentFile,
  });
}
