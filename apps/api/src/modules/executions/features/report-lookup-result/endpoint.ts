import { lookupResultRequestSchema } from '@agentic-studio/contracts';
import { Body, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { WorkerController } from '../../../../platform/auth/worker-route.js';
import {
  FieldProblemException,
  zodFieldErrors,
} from '../../../../platform/http/problem-details.js';
import {
  lookupKindMismatch,
  lookupNotFound,
  lookupNotHeld,
} from '../../contracts/http/problems.js';
import {
  LookupKindMismatchError,
  LookupNotFoundError,
  LookupNotHeldError,
  ReportLookupResultHandler,
} from './handler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `POST /api/worker/lookups/:id/result` (Issue #142), worker token only: 204 once the result
 * (or the failure) is recorded, 404 for an unknown lookup, 409 unless this worker holds it or
 * when the answer is of another kind, 422 for an invalid body. The body is a union of the
 * result and the failure, so the endpoint validates it with the shared contract itself.
 */
@WorkerController('lookups')
export class ReportLookupResultEndpoint {
  constructor(private readonly handler: ReportLookupResultHandler) {}

  @Post(':lookupId/result')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Param('lookupId') lookupId: string, @Body() body: unknown) {
    const parsed = lookupResultRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new FieldProblemException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'The request is invalid.',
        zodFieldErrors(parsed.error),
      );
    }
    if (!UUID.test(lookupId)) throw lookupNotFound();
    try {
      await this.handler.execute(lookupId, parsed.data);
    } catch (error) {
      if (error instanceof LookupNotFoundError) throw lookupNotFound();
      if (error instanceof LookupNotHeldError) throw lookupNotHeld();
      if (error instanceof LookupKindMismatchError) throw lookupKindMismatch();
      throw error;
    }
  }
}
