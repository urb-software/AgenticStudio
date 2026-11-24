import { applyDecorators, Controller, SetMetadata } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

export const IS_CONTROLLER_ROUTE = Symbol('IS_CONTROLLER_ROUTE');

/**
 * A controller of the environment controller protocol under `/api/controller/<path>`,
 * authenticated by the controller token only (`SessionGuard`) and left out of the OpenAPI
 * document and the Origin check.
 */
export const EnvironmentControllerEndpoint = (path: string) =>
  applyDecorators(
    Controller(`controller/${path}`),
    SetMetadata(IS_CONTROLLER_ROUTE, true),
    ApiExcludeController(),
  );
