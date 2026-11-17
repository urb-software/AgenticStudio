import { NO_TRUSTED_HOST_KEY_DETAIL } from './repository-failure.js';

/** No host key is trusted for the Repository's Git host: Studio does not connect. */
export class NoTrustedHostKeyError extends Error {
  constructor() {
    super(NO_TRUSTED_HOST_KEY_DETAIL);
    this.name = 'NoTrustedHostKeyError';
  }
}

/** The project already has a Repository that is connecting or connected. */
export class RepositoryAlreadyConnectedError extends Error {
  constructor() {
    super('The project already has a repository.');
    this.name = 'RepositoryAlreadyConnectedError';
  }
}

/** A connect or fetch of the Repository is still running (`connecting` or `fetching`). */
export class RepositoryBusyError extends Error {
  constructor() {
    super('A connect or fetch of the repository is still running.');
    this.name = 'RepositoryBusyError';
  }
}

/**
 * The Repository is not waiting for its Deploy key or host key to be verified (it is not an
 * SSH Repository, or not `awaiting_key`, `awaiting_host_key` or `failed` without a Clone), or
 * a fingerprint was confirmed while no host key awaits confirmation.
 */
export class RepositoryNotVerifiableError extends Error {
  constructor(message = 'The repository is not waiting to be verified.') {
    super(message);
    this.name = 'RepositoryNotVerifiableError';
  }

  /** A fingerprint was confirmed while no host key awaits confirmation. */
  static noHostKeyAwaiting(): RepositoryNotVerifiableError {
    return new RepositoryNotVerifiableError(
      'No host key is waiting for confirmation. Verify again first.',
    );
  }
}

/** The Repository has no usable Clone to fetch into; a Retry (connect) makes a new one. */
export class NoUsableCloneError extends Error {
  constructor() {
    super('The repository has no usable clone.');
    this.name = 'NoUsableCloneError';
  }
}

/** The confirmed fingerprint is not the one of the host key awaiting confirmation. */
export class HostKeyFingerprintMismatchError extends Error {
  constructor() {
    super(
      'The fingerprint does not match the host key Studio retrieved. Verify again to retrieve the host key again.',
    );
    this.name = 'HostKeyFingerprintMismatchError';
  }
}
