import { Injectable } from '@nestjs/common';
import type { HttpRequest } from './http-types.js';
import { SessionCookie } from './session-cookie.js';
import { SessionStore } from './session-store.js';

/** Read-only view of operator sessions: it can neither create, extend nor delete one. */
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
