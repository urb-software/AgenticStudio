import type { RepositoryOutput } from '../../../../platform/api';

type Failure = NonNullable<RepositoryOutput['failure']>;

/** The detail the API stores for a clone cut off by a crash or a restart. */
const INTERRUPTED = 'Interrupted';

/**
 * The operator-facing message for a failure reason code (Epic #55's fixed list). A code this
 * version does not know (added by a later API) gets a generic message; the redacted detail is
 * shown next to it either way.
 */
export function failureMessage(failure: Failure, integrationBranch: string): string {
  switch (failure.code as string) {
    case 'host_unreachable':
      return 'Studio could not reach the Git host. Check the URL and that the host is online.';
    case 'repository_not_found':
      return 'The repository was not found. Check the URL: only public repositories can be connected over HTTPS.';
    case 'branch_not_found':
      return failure.remoteDefaultBranch
        ? `The branch "${integrationBranch}" does not exist on the remote. Its default branch is "${failure.remoteDefaultBranch}".`
        : `The branch "${integrationBranch}" does not exist on the remote.`;
    case 'timeout':
      return 'The Git host took too long, so the clone was stopped.';
    case 'size_limit':
      return 'The repository is larger than the 2 GB limit, so the clone was stopped.';
    case 'auth_failed':
      return 'The Git host asked for credentials. Only public repositories can be connected over HTTPS.';
    case 'host_key_mismatch':
      return "The Git host's key did not match the expected one.";
    case 'unknown':
      return failure.detail === INTERRUPTED
        ? 'The clone was interrupted, for example by a restart of Studio.'
        : 'The clone failed for an unexpected reason.';
    default:
      return 'The clone failed.';
  }
}
