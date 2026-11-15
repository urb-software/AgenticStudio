import { applyDecorators, Controller, SetMetadata } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

export const IS_WORKER_ROUTE = Symbol('IS_WORKER_ROUTE');

/**
 * A controller of the agent worker protocol (Issue #96), served under `/api/worker/<path>`.
 * Its routes are authenticated by the worker token only: the operator session grants
 * nothing there, and the worker token grants nothing anywhere else (`SessionGuard`). They
 * are left out of the OpenAPI document, so the browser client never contains them, and the
 * mutation Origin check does not apply (no cookie authenticates them).
 */
export const WorkerController = (path: string) =>
  applyDecorators(
    Controller(`worker/${path}`),
    SetMetadata(IS_WORKER_ROUTE, true),
    ApiExcludeController(),
  );
