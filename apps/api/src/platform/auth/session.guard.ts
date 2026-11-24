import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { KeyObject } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { verifyBearerToken } from './bearer-token.js';
import { IS_CONTROLLER_ROUTE } from './controller-route.js';
import type { HttpRequest } from './http-types.js';
import { IS_PUBLIC } from './public.decorator.js';
import { SessionCookie } from './session-cookie.js';
import { SessionStore } from './session-store.js';
import { IS_WORKER_ROUTE } from './worker-route.js';

/** The one 401 detail, so no failure reveals why authentication failed. */
export const NOT_AUTHENTICATED = 'Not authenticated.';

/**
 * Denies every route unless marked {@link Public}. A worker route is authenticated by the
 * worker token alone and a controller route by the controller token alone: the cookie grants
 * nothing there, and neither token grants anything elsewhere.
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
      return this.requireToken(this.config.workerToken, request);
    }
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_CONTROLLER_ROUTE, targets)) {
      return this.requireToken(this.config.controllerToken, request);
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

  private requireToken(expected: KeyObject | null, request: HttpRequest): true {
    if (verifyBearerToken(expected, request.headers.authorization)) return true;
    throw new UnauthorizedException(NOT_AUTHENTICATED);
  }
}
