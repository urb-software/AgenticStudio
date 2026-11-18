import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import type { HttpRequest } from './http-types.js';
import { IS_PUBLIC } from './public.decorator.js';
import { SessionCookie } from './session-cookie.js';
import { SessionStore } from './session-store.js';
import { IS_WORKER_ROUTE } from './worker-route.js';
import { verifyWorkerToken } from './worker-token.js';

/** The one 401 detail, so no failure reveals why authentication failed. */
export const NOT_AUTHENTICATED = 'Not authenticated.';

/**
 * Denies every route unless marked {@link Public}. A worker route is authenticated by the
 * worker token alone: the cookie grants nothing there and the token grants nothing elsewhere.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cookie: SessionCookie,
    private readonly sessions: SessionStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<HttpRequest>();
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_WORKER_ROUTE, targets)) {
      if (verifyWorkerToken(this.config.workerToken, request.headers.authorization)) {
        return true;
      }
      throw new UnauthorizedException(NOT_AUTHENTICATED);
    }
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, targets);
    if (isPublic) {
      return true;
    }
    const sessionId = this.cookie.read(request);
    if (sessionId && (await this.sessions.touch(sessionId))) {
      return true;
    }
    throw new UnauthorizedException(NOT_AUTHENTICATED);
  }
}
