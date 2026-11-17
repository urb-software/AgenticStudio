export const OPERATOR_SESSIONS = Symbol('OPERATOR_SESSIONS');

export interface OperatorSessions {
  isValid(token: string): Promise<boolean>;
}
