/** DI token of the {@link OperatorLogin} setting (`STUDIO_OPERATOR_GITHUB_LOGIN`, Issue #146). */
export const OPERATOR_LOGIN = Symbol('OPERATOR_LOGIN');

/**
 * The operator's own GitHub login, or `null` when it is not configured: Review comments written
 * by it are preselected for a Follow-up; everyone else's never are.
 */
export interface OperatorLogin {
  login: string | null;
}
