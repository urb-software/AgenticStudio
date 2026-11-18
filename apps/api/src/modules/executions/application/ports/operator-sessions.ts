export const OPERATOR_SESSIONS = Symbol('OPERATOR_SESSIONS');

/** Live log streams are bounded per session and end with it. */
export interface OperatorSessions {
  idOf(request: unknown): string | undefined;
  /** Does not extend the session. */
  isActive(sessionId: string): Promise<boolean>;
}
