/** A pull request's page on github.com, exactly as the worker protocol accepts it (Issue #115). */
const GITHUB_PULL_REQUEST = /^https:\/\/github\.com\/[^/?#@:]+\/[^/?#@:]+\/pull\/[1-9]\d*$/;

/**
 * Whether `url` is a pull request page on github.com over https, without credentials, port,
 * query or fragment (Issue #115). The worker protocol only accepts such URLs; this keeps any
 * other host from ever becoming a link on the Run page (also its Changes tab, Issue #144).
 */
export function isGitHubPullRequestUrl(url: string): boolean {
  if (!GITHUB_PULL_REQUEST.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'github.com' &&
      parsed.port === '' &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/** The pull request's "Files changed" page, or `null` when it is not on github.com (Issue #144). */
export function pullRequestFilesUrl(pullRequestUrl: string): string | null {
  return isGitHubPullRequestUrl(pullRequestUrl) ? `${pullRequestUrl}/files` : null;
}
