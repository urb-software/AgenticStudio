import { Injectable } from '@nestjs/common';
import type { HttpRequest } from './http-types.js';
import { SessionCookie } from './session-cookie.js';
import { SessionStore } from './session-store.js';

/**
 * The read-only view of operator sessions that `AuthModule` exports (Issue #104, prerequisite
 * from the #119 review), instead of the session store itself: a long-lived response (the live
 * Run log) reads the session id its request carries and checks that the session is still
 * valid, and can neither create, extend nor delete a session.
 */
@Injectable()
export class OperatorSessionCheck {
  constructor(
    private readonly cookie: SessionCookie,
    private readonly sessions: SessionStore,
  ) {}

  /** The session id the request's cookie carries, if any (never log it). */
  idOf(request: unknown): string | undefined {
    return this.cookie.read(request as HttpRequest);
  }

  /** Whether the session exists and is within its lifetime, without extending it. */
  isActive(sessionId: string): Promise<boolean> {
    return this.sessions.isActive(sessionId);
  }
}
