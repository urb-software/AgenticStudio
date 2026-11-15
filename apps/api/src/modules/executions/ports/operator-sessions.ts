/** DI token of the {@link OperatorSessions} port. */
export const OPERATOR_SESSIONS = Symbol('OPERATOR_SESSIONS');

/**
 * The operator session behind a request (Issue #99 review): a long-lived response, the live
 * log stream, needs its id to bound streams per session and to end when the session does.
 */
export interface OperatorSessions {
  /** The session id the request carries (the global guard has already checked it). */
  idOf(request: unknown): string | undefined;
  /** Whether the session is still valid, without extending it. */
  isActive(sessionId: string): Promise<boolean>;
}
