export const OPERATOR_LOGIN = Symbol('OPERATOR_LOGIN');

/** `null` when not configured. */
export interface OperatorLogin {
  login: string | null;
}
