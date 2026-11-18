import { Injectable } from '@nestjs/common';
import { OperatorSessionCheck } from '../../../../platform/auth/operator-session-check.js';
import type { OperatorSessions } from '../../application/ports/operator-sessions.js';

@Injectable()
export class PlatformOperatorSessions implements OperatorSessions {
  constructor(private readonly sessions: OperatorSessionCheck) {}

  idOf(request: unknown): string | undefined {
    return this.sessions.idOf(request);
  }

  isActive(sessionId: string): Promise<boolean> {
    return this.sessions.isActive(sessionId);
  }
}
