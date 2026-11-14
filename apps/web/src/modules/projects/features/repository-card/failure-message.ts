import type { RepositoryOutput } from '../../../../platform/api';

type Failure = NonNullable<RepositoryOutput['failure']>;

/** What failed: the first clone (or a Retry), or a fetch into an existing Clone. */
export type FailedOperation = 'clone' | 'fetch';

/** How Studio reaches the Repository: anonymous HTTPS, or SSH with the Deploy key (#62). */
export type Transport = 'https' | 'ssh';

/**
 * The part of a failure's detail the card shows as Git output. For `host_key_mismatch` the API
 * puts Studio's own explanation first, then a blank line and the redacted Git output (or only
 * the explanation, when there is no output); the card's message already gives that advice, so
 * only the Git output is shown, and nothing when there is none (#72).
 */
export function gitOutputOf(failure: Failure): string {
  if (failure.code !== 'host_key_mismatch') return failure.detail;
  const end = failure.detail.indexOf('\n\n');
  return end === -1 ? '' : failure.detail.slice(end + 2);
}

/**
 * The operator-facing message for a failure reason code (Epic #55's fixed list). A code this
 * version does not know (added by a later API) gets a generic message; the redacted detail is
 * shown next to it either way.
 */
export function failureMessage(
  failure: Failure,
  integrationBranch: string,
  operation: FailedOperation = 'clone',
  transport: Transport = 'https',
): string {
  const ssh = transport === 'ssh';
  switch (failure.code as string) {
    case 'host_unreachable':
      return 'Studio could not reach the Git host. Check the URL and that the host is online.';
    case 'repository_not_found':
      if (ssh) {
        return 'The repository was not found, or the deploy key has no access to it. Check the URL and that the key below is added for this repository.';
      }
      return operation === 'fetch'
        ? 'The repository was not found. Check that it still exists and is public.'
        : 'The repository was not found. Check the URL: only public repositories can be connected over HTTPS.';
    case 'branch_not_found':
      if (operation === 'fetch') {
        return `The branch "${integrationBranch}" no longer exists on the remote. Change the settings to use another branch.`;
      }
      return failure.remoteDefaultBranch
        ? `The branch "${integrationBranch}" does not exist on the remote. Its default branch is "${failure.remoteDefaultBranch}".`
        : `The branch "${integrationBranch}" does not exist on the remote.`;
    case 'timeout':
      return `The Git host took too long, so the ${operation} was stopped.`;
    case 'size_limit':
      return 'The repository is larger than the 2 GB limit, so Studio stopped and kept no clone.';
    case 'auth_failed':
      if (ssh) {
        return operation === 'fetch'
          ? "The Git host refused Studio's deploy key. Check that the key is still added as a deploy key for this repository, then fetch again."
          : "The Git host refused Studio's deploy key. Add the key below as a deploy key for this repository (read access is enough), then Retry. The key stays the same.";
      }
      return 'The Git host asked for credentials. Only public repositories can be connected over HTTPS.';
    case 'host_key_mismatch':
      return 'The Git host presented a different host key than the one Studio trusts, so Studio did not connect. Studio never accepts a changed key on its own: if the change is expected, disconnect the repository and connect it again.';
    // Issue #69: the remote address policy. The detail names the address and, for a loopback
    // or private one, the setting that allows it.
    case 'remote_not_allowed':
      return 'Studio does not connect to this address: it is link-local, a cloud metadata service, or loopback or private without STUDIO_GIT_ALLOW_PRIVATE_REMOTES=true. The detail below names the address.';
    case 'redirect_refused':
      return 'The Git host redirected Studio to another URL, and Studio does not follow redirects. Connect with the final URL of the repository.';
    // An operation cut off by a crash or a restart of Studio (#72), not by the repository.
    case 'interrupted':
      return `The ${operation} was interrupted, for example by a restart of Studio.`;
    case 'unknown':
      return `The ${operation} failed for an unexpected reason.`;
    default:
      return `The ${operation} failed.`;
  }
}
