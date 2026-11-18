import { applyDecorators, Controller, SetMetadata } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

export const IS_WORKER_ROUTE = Symbol('IS_WORKER_ROUTE');

/**
 * A controller of the agent worker protocol under `/api/worker/<path>`, authenticated by the
 * worker token only (`SessionGuard`) and left out of the OpenAPI document and Origin check.
 */
export const WorkerController = (path: string) =>
  applyDecorators(
    Controller(`worker/${path}`),
    SetMetadata(IS_WORKER_ROUTE, true),
    ApiExcludeController(),
  );
