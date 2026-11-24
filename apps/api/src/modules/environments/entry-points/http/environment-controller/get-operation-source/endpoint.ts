import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { operationSourceQuerySchema } from '@agentic-studio/contracts';
import { Get, Logger, Param, Query, Res } from '@nestjs/common';
import { EnvironmentControllerEndpoint } from '../../../../../../platform/auth/controller-route.js';
import {
  FieldProblemException,
  zodFieldErrors,
} from '../../../../../../platform/http/problem-details.js';
import {
  type GetPreviewOperationSourceResult,
  GetPreviewOperationSourceHandler,
} from '../../../../application/features/get-preview-operation-source/handler.js';
import {
  PreviewOperationNotABuildError,
  PreviewOperationNotFoundError,
  PreviewOperationNotHeldError,
} from '../../../../domain/errors/preview-operation-errors.js';
import {
  operationNotABuild,
  operationNotFound,
  operationNotHeld,
  operationSourceTooLarge,
  operationSourceUnavailable,
} from '../../shared/problems.js';
import { HttpStatus } from '@nestjs/common';

@EnvironmentControllerEndpoint('operations')
export class GetOperationSourceEndpoint {
  private readonly logger = new Logger('GetOperationSource');

  constructor(private readonly handler: GetPreviewOperationSourceHandler) {}

  /** The tracked tree of the build's commit as `application/x-tar` with its `Content-Length`. */
  @Get(':operationId/source')
  async source(
    @Param('operationId') operationId: string,
    @Query() query: unknown,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const parsed = operationSourceQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    let result: GetPreviewOperationSourceResult;
    try {
      result = await this.handler.execute({ operationId, controllerId: parsed.data.controllerId });
    } catch (error) {
      if (error instanceof PreviewOperationNotFoundError) throw operationNotFound();
      if (error instanceof PreviewOperationNotHeldError) throw operationNotHeld();
      if (error instanceof PreviewOperationNotABuildError) throw operationNotABuild();
      throw error;
    }
    if (result.status === 'source_too_large') throw operationSourceTooLarge();
    if (result.status === 'source_unavailable') throw operationSourceUnavailable();
    try {
      response.writeHead(HttpStatus.OK, {
        'Content-Type': 'application/x-tar',
        'Content-Length': String(result.sizeBytes),
        'Cache-Control': 'no-store',
      });
      await pipeline(Readable.from(result.chunks), response);
    } catch (error) {
      // The headers are sent, so no problem response is possible: the controller sees a short
      // body and retries or reports `source_unavailable`.
      this.logger.warn(
        `The source of operation ${operationId} could not be sent: ${error instanceof Error ? error.name : 'Error'}`,
      );
    } finally {
      await result.close().catch(() => {
        // The start-up sweep removes what a failed delete leaves.
        this.logger.warn(`The archive of operation ${operationId} could not be removed.`);
      });
    }
  }
}
