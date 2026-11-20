/** A pull request's page on github.com, exactly as the worker protocol accepts it. */
const GITHUB_PULL_REQUEST = /^https:\/\/github\.com\/[^/?#@:]+\/[^/?#@:]+\/pull\/[1-9]\d*$/;

/**
 * Whether `url` is a pull request page on github.com over https, without credentials, port,
 * query or fragment. The worker protocol only accepts such URLs; this keeps any other host from
 * ever becoming a link on the Run page.
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

/** The pull request's "Files changed" page, or `null` when it is not on github.com. */
export function pullRequestFilesUrl(pullRequestUrl: string): string | null {
  return isGitHubPullRequestUrl(pullRequestUrl) ? `${pullRequestUrl}/files` : null;
}

/**
 * Whether `url` is a page on github.com over https, without credentials or port: the only links
 * a Pull request check gets. A check from another CI system may link anywhere; that address is
 * not made a link on the Run page.
 */
export function isGitHubUrl(url: string): boolean {
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
