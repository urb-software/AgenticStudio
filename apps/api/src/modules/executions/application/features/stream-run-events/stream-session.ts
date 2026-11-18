import { Inject, Injectable } from '@nestjs/common';
import { OPERATOR_SESSIONS, type OperatorSessions } from '../../ports/operator-sessions.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from '../../ports/run-log-settings.js';

/**
 * Checked every {@link checkIntervalMs}, so a logout or expiry ends a live stream.
 * Read-only: it can neither create, extend nor delete a session.
 */
@Injectable()
export class StreamSession {
  constructor(
    @Inject(OPERATOR_SESSIONS) private readonly sessions: OperatorSessions,
    @Inject(RUN_LOG_SETTINGS) private readonly settings: RunLogSettings,
  ) {}

  get checkIntervalMs(): number {
    return this.settings.keepAliveMs;
  }

  idOf(request: unknown): string | undefined {
    return this.sessions.idOf(request);
  }

  /** Whether the session is still valid, without extending it. */
  isActive(sessionId: string): Promise<boolean> {
    return this.sessions.isActive(sessionId);
  }
}
