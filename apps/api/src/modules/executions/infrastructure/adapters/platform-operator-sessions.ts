import { Injectable } from '@nestjs/common';
import type { HttpRequest } from '../../../../platform/auth/http-types.js';
import { SessionCookie } from '../../../../platform/auth/session-cookie.js';
import { SessionStore } from '../../../../platform/auth/session-store.js';
import type { OperatorSessions } from '../../ports/operator-sessions.js';

/** {@link OperatorSessions} over the platform's session cookie and Redis session store. */
@Injectable()
export class PlatformOperatorSessions implements OperatorSessions {
  constructor(
    private readonly cookie: SessionCookie,
    private readonly sessions: SessionStore,
  ) {}

  idOf(request: unknown): string | undefined {
    return this.cookie.read(request as HttpRequest);
  }

  isActive(sessionId: string): Promise<boolean> {
    return this.sessions.isActive(sessionId);
  }
}
