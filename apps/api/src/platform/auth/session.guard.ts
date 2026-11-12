import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { HttpRequest } from './http-types.js';
import { IS_PUBLIC } from './public.decorator.js';
import { SessionCookie } from './session-cookie.js';
import { SessionStore } from './session-store.js';

/** The one 401 detail, so no failure reveals why authentication failed. */
export const NOT_AUTHENTICATED = 'Not authenticated.';

/** Global guard: denies every route by default unless it is marked {@link Public}. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly cookie: SessionCookie,
    private readonly sessions: SessionStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }
    const sessionId = this.cookie.read(context.switchToHttp().getRequest<HttpRequest>());
    if (sessionId && (await this.sessions.touch(sessionId))) {
      return true;
    }
    throw new UnauthorizedException(NOT_AUTHENTICATED);
  }
}
