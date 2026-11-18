import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { HttpRequest } from './http-types.js';
import { IS_WORKER_ROUTE } from './worker-route.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Tokenless CSRF defence on every mutation: `Origin` must be the Studio origin (or
 * `Sec-Fetch-Site: same-origin` without it), and a body must be JSON, which no form can send.
 * Worker routes skip the Origin check only: no cookie authenticates them.
 */
@Injectable()
export class MutationOriginGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (SAFE_METHODS.has(request.method ?? '')) {
      return true;
    }
    const isWorkerRoute = this.reflector.getAllAndOverride<boolean | undefined>(IS_WORKER_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isWorkerRoute && !this.isSameOrigin(request)) {
      throw new ForbiddenException('Cross-origin request rejected.');
    }
    if (hasBody(request) && !isJson(request.headers['content-type'])) {
      throw new UnsupportedMediaTypeException('Content-Type must be application/json.');
    }
    return true;
  }

  private isSameOrigin(request: HttpRequest): boolean {
    const origin = request.headers.origin;
    if (origin !== undefined) {
      return origin === this.config.studioOrigin;
    }
    return request.headers['sec-fetch-site'] === 'same-origin';
  }
}

function hasBody(request: HttpRequest): boolean {
  const { headers } = request;
  return (
    headers['content-type'] !== undefined ||
    headers['transfer-encoding'] !== undefined ||
    (headers['content-length'] !== undefined && headers['content-length'] !== '0')
  );
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
