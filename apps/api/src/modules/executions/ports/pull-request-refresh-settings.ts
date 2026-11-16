/** DI token of the {@link PullRequestRefreshSettings}. */
export const PULL_REQUEST_REFRESH_SETTINGS = Symbol('PULL_REQUEST_REFRESH_SETTINGS');

/**
 * When the daily pull request refresh runs (Issue #142). Production: every `intervalMs` from the
 * start. A test passes `manual`, which is handed the pass instead of a timer, so it runs the
 * refresh exactly when it wants to.
 */
export interface PullRequestRefreshSettings {
  intervalMs: number;
  manual?: (pass: () => Promise<void>) => void;
}
