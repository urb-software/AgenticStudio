import { Inject, Injectable } from '@nestjs/common';
import { OPERATOR_SESSIONS, type OperatorSessions } from '../../ports/operator-sessions.js';
import { RUN_LOG_SETTINGS, type RunLogSettings } from '../../ports/run-log-settings.js';

/**
 * The operator session behind a live log stream (Issue #99 review, #104): a long-lived
 * response needs its id to bound streams per session, and checks every {@link checkIntervalMs}
 * that the session is still valid, so a logout or expiry ends the stream. Read-only: it can
 * neither create, extend nor delete a session.
 */
@Injectable()
export class StreamSession {
  constructor(
    @Inject(OPERATOR_SESSIONS) private readonly sessions: OperatorSessions,
    @Inject(RUN_LOG_SETTINGS) private readonly settings: RunLogSettings,
  ) {}

  /** How often a live stream, idle or busy, checks its session (the keep-alive interval). */
  get checkIntervalMs(): number {
    return this.settings.keepAliveMs;
  }

  /** The session id the request carries (the global guard has already checked it). */
  idOf(request: unknown): string | undefined {
    return this.sessions.idOf(request);
  }

  /** Whether the session is still valid, without extending it. */
  isActive(sessionId: string): Promise<boolean> {
    return this.sessions.isActive(sessionId);
  }
}
