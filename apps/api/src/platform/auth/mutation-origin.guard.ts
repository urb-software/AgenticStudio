import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { HttpRequest } from './http-types.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense without a token (Epic #8 decision 3), applied to every mutation,
 * public ones (login) included:
 * - `Origin` must equal the Studio origin; without `Origin`, only
 *   `Sec-Fetch-Site: same-origin` is accepted. A foreign `Origin` always loses.
 * - A request body must be `application/json`, which no HTML form can send.
 */
@Injectable()
export class MutationOriginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (SAFE_METHODS.has(request.method ?? '')) {
      return true;
    }
    if (!this.isSameOrigin(request)) {
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

/** A Content-Type, a non-zero Content-Length or chunked encoding all mean a body. */
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
