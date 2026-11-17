import { hostKeyFingerprint } from '../value-objects/ssh-key.js';
import { gitHostName } from '../value-objects/trusted-host-keys.js';
import {
  NO_TRUSTED_HOST_KEY_DETAIL,
  RepositoryFailure,
} from '../value-objects/repository-failure.js';

/**
 * The states of a Repository: the last operation, not whether a Clone exists (see
 * `RepositoryConnection.hasClone`). An SSH Repository starts in `awaiting_key`: its Deploy key
 * still has to be added on the Git host, then verified (Issue #62); `awaiting_host_key`: the
 * Git host is not trusted yet and the operator has to confirm its host key. `connecting`: the first Clone is being made; `ready`: the
 * Clone is up to date as of the last fetch; `fetching`: the Clone is being brought up to date;
 * `failed`: the last connect or fetch failed; `disconnecting`: the operator disconnected it and
 * its data is still being removed (the record goes last). Later stories add states.
 */
export const REPOSITORY_STATES = [
  'awaiting_key',
  'awaiting_host_key',
  'connecting',
  'ready',
  'fetching',
  'failed',
  'disconnecting',
] as const;
export type RepositoryState = (typeof REPOSITORY_STATES)[number];

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

const NOT_WAITING_FOR_HOST_KEY = 'No host key is waiting for confirmation. Verify again first.';

/** What a store keeps of a Repository: everything but the derived fields. */
export interface StoredRepositoryConnection {
  projectId: string;
  /** The URL as the operator entered it (trimmed). */
  url: string;
  integrationBranch: string;
  state: RepositoryState;
  /** Commit id of the Integration branch in the Clone; set exactly when a usable Clone exists. */
  headSha: string | null;
  /** When the Clone was last brought up to date; set exactly when `headSha` is. */
  lastFetchedAt: Date | null;
  /** Set exactly when `failed`. */
  failure: RepositoryFailure | null;
  /**
   * SSH Repositories only (Issue #62): the public half of the project's Deploy key, one
   * OpenSSH line (`ssh-ed25519 AAAA… studio-<project>`); set exactly when `deployKeySecret` is.
   */
  publicKey: string | null;
  /**
   * The secret store's reference to the Deploy key's private half; never the key itself.
   * Set exactly for an SSH Repository (until a Disconnect removes it).
   */
  deployKeySecret: string | null;
  /** The host key the operator confirmed, pinned for this Repository: `<type> <base64>`. */
  pinnedHostKey: string | null;
  /** The retrieved host key awaiting the operator's confirmation; set exactly when `awaiting_host_key`. */
  pendingHostKey: string | null;
}

/**
 * A Repository's state as a plain record, with the fields derived from it: what the
 * {@link RepositoryConnection} class exposes and what crosses a boundary is mapped from.
 */
export interface RepositoryConnectionData extends StoredRepositoryConnection {
  /**
   * Whether a usable Clone exists: always when `ready` or `fetching`; when `failed`, only if
   * the failure was a fetch that kept the Clone. Never while `connecting` or `disconnecting`.
   */
  hasClone: boolean;
  /**
   * SHA256 fingerprint of `pendingHostKey` when awaiting confirmation, otherwise of
   * `pinnedHostKey`; `null` when there is neither. Derived, never stored (#72).
   */
  hostKeyFingerprint: string | null;
}

/** A Repository's current values as read-only plain data: what a handler returns of it. */
export type RepositoryConnectionSnapshot = Readonly<RepositoryConnectionData>;

/** What a Connect (or a Retry) stores before the Clone is made. */
export interface ConnectAttempt {
  projectId: string;
  /** The URL as entered (trimmed). */
  url: string;
  /** The remote's identity (`remoteIdentity`); unique across Projects. */
  identity: string;
  integrationBranch: string;
  /**
   * SSH only (Issue #62): the project's Deploy key. With it the Repository is stored
   * `awaiting_key` (the operator adds the key on the Git host, then verifies); without it,
   * `connecting`.
   */
  deployKey?: { publicKey: string; secretRef: string } | null;
  /** SSH only: a host key already confirmed for this host, kept across a Retry. */
  pinnedHostKey?: string | null;
  /**
   * True when `deployKey` is the failed Repository's own key, kept by a Retry (Issue #76): the
   * Retry then applies only while the Repository still exists and references that key. A key a
   * concurrent Connect or Disconnect released may already be deleted, so it is never saved again.
   */
  keepsDeployKey?: boolean;
}

/**
 * What changed on a Repository since it was started or restored, for the store to save in one
 * step: the new values of the changed fields, the remote's identity when the change starts or
 * replaces the connection, and whether the record goes (the last step of a Disconnect).
 */
export interface RepositoryChanges {
  fields: Partial<StoredRepositoryConnection>;
  identity?: string;
  removed?: true;
}

const CHANGES = new WeakMap<RepositoryConnection, RepositoryChanges>();

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * The Repository connected to a Project (at most one per Project): a class that owns its
 * lifecycle. Starting a connect, awaiting a Deploy key or a host key, verifying, completing or
 * failing a clone, starting and finishing a fetch, and disconnecting are methods that check
 * their own preconditions. The operator's operations refuse with a domain error when they do
 * not apply; what a Git job reports late (it ended after a Disconnect or a restart) returns
 * `false` and changes nothing. The store saves {@link RepositoryConnection.pendingChanges} in
 * one transaction under the Repository's row lock, so two simultaneous changes cannot both win.
 *
 * It cannot be built in an invalid state: only {@link RepositoryConnection.start} and
 * {@link RepositoryConnection.restore} make one. Its fields are readable and never assigned
 * from outside.
 */
export class RepositoryConnection {
  declare readonly projectId: RepositoryConnectionData['projectId'];
  declare readonly url: RepositoryConnectionData['url'];
  declare readonly integrationBranch: RepositoryConnectionData['integrationBranch'];
  declare readonly state: RepositoryConnectionData['state'];
  declare readonly hasClone: RepositoryConnectionData['hasClone'];
  declare readonly headSha: RepositoryConnectionData['headSha'];
  declare readonly lastFetchedAt: RepositoryConnectionData['lastFetchedAt'];
  declare readonly failure: RepositoryConnectionData['failure'];
  declare readonly publicKey: RepositoryConnectionData['publicKey'];
  declare readonly deployKeySecret: RepositoryConnectionData['deployKeySecret'];
  declare readonly pinnedHostKey: RepositoryConnectionData['pinnedHostKey'];
  declare readonly pendingHostKey: RepositoryConnectionData['pendingHostKey'];
  declare readonly hostKeyFingerprint: RepositoryConnectionData['hostKeyFingerprint'];

  private constructor(stored: StoredRepositoryConnection, changes: RepositoryChanges) {
    Object.assign(this, withDerived(stored));
    CHANGES.set(this, changes);
  }

  /**
   * A new Repository for a Connect: `connecting`, or `awaiting_key` with a Deploy key. A kept
   * key (`keepsDeployKey`) belongs to a Repository that must still exist, so it is refused here
   * with {@link RepositoryAlreadyConnectedError}.
   */
  static start(attempt: ConnectAttempt): RepositoryConnection {
    if (attempt.keepsDeployKey) throw new RepositoryAlreadyConnectedError();
    const stored = newAttempt(attempt);
    return new RepositoryConnection(stored, { fields: { ...stored }, identity: attempt.identity });
  }

  /**
   * A Repository as storage holds it. Throws {@link TypeError} for state the store should never
   * hold (the database's CHECK constraints say the same).
   */
  static restore(stored: StoredRepositoryConnection): RepositoryConnection {
    const { state } = stored;
    if (!isOneOf(REPOSITORY_STATES, state)) {
      throw new TypeError(`Unknown repository state: ${state}`);
    }
    if ((state === 'failed') !== (stored.failure !== null)) {
      throw new TypeError('A Repository has a failure exactly when it is failed.');
    }
    if ((stored.headSha === null) !== (stored.lastFetchedAt === null)) {
      throw new TypeError("A Repository's Clone commit and fetch time go together.");
    }
    const hasCommit = stored.headSha !== null;
    if ((state === 'ready' || state === 'fetching') && !hasCommit) {
      throw new TypeError(`A ${state} Repository has a Clone.`);
    }
    if (
      hasCommit &&
      ['awaiting_key', 'awaiting_host_key', 'connecting', 'disconnecting'].includes(state)
    ) {
      throw new TypeError(`A ${state} Repository has no Clone.`);
    }
    if ((stored.deployKeySecret === null) !== (stored.publicKey === null)) {
      throw new TypeError("A Deploy key's public half and its reference go together.");
    }
    if (
      (state === 'awaiting_key' ||
        state === 'awaiting_host_key' ||
        stored.pinnedHostKey !== null) &&
      stored.deployKeySecret === null
    ) {
      throw new TypeError('Only an SSH Repository waits for a key or pins a host key.');
    }
    if ((state === 'awaiting_host_key') !== (stored.pendingHostKey !== null)) {
      throw new TypeError('A host key awaits confirmation exactly in awaiting_host_key.');
    }
    return new RepositoryConnection({ ...stored }, { fields: {} });
  }

  /** The state as a plain record (a copy), for what crosses a boundary. */
  snapshot(): RepositoryConnectionSnapshot {
    return withDerived(this.stored());
  }

  /** What changed since the Repository was started or restored; the store saves exactly this. */
  pendingChanges(): RepositoryChanges {
    const pending = CHANGES.get(this)!;
    return { ...pending, fields: { ...pending.fields } };
  }

  /**
   * Which Git job runs for the Repository's state: `clone` while `connecting`, `fetch` while
   * `fetching`; `null` otherwise (a job left over from before a restart does nothing).
   */
  get pendingOperation(): 'clone' | 'fetch' | null {
    if (this.state === 'connecting') return 'clone';
    if (this.state === 'fetching') return 'fetch';
    return null;
  }

  /** Whether the operator disconnected it and its data is still being removed. */
  get isDisconnecting(): boolean {
    return this.state === 'disconnecting';
  }

  /**
   * Whether "Verify and clone" applies (Issue #62): an SSH Repository (it has a Deploy key)
   * without a Clone that is `awaiting_key`, `awaiting_host_key`, or `failed` (Retry keeps the
   * Deploy key).
   */
  get isVerifiable(): boolean {
    return (
      this.deployKeySecret !== null &&
      !this.hasClone &&
      (this.state === 'awaiting_key' ||
        this.state === 'awaiting_host_key' ||
        this.state === 'failed')
    );
  }

  /** Throws {@link RepositoryNotVerifiableError} unless {@link isVerifiable}. */
  assertVerifiable(): void {
    if (!this.isVerifiable) throw new RepositoryNotVerifiableError();
  }

  /**
   * The Deploy key a Retry of a failed Repository keeps (Issue #76), or `null` for any other
   * Repository.
   */
  get retainedDeployKey(): { publicKey: string; secretRef: string } | null {
    return this.state === 'failed' && this.deployKeySecret && this.publicKey
      ? { secretRef: this.deployKeySecret, publicKey: this.publicKey }
      : null;
  }

  /** Whether it still holds a Deploy key reference, a public key or a host key to forget. */
  get holdsDeployKeyMaterial(): boolean {
    return (
      this.deployKeySecret !== null ||
      this.publicKey !== null ||
      this.pinnedHostKey !== null ||
      this.pendingHostKey !== null
    );
  }

  /**
   * The host key pinned for this Repository, when a Retry of it names the same Git host as
   * `url`: a host key the operator confirmed is kept across a Retry over the same host only.
   */
  pinnedHostKeyFor(url: string): string | null {
    const host = gitHostName(this.url);
    return host !== null && host === gitHostName(url) ? this.pinnedHostKey : null;
  }

  /**
   * The failure a Repository takes when its clone could not be scheduled after it was stored:
   * the failed Repository's own failure when this attempt repeats it (same `settings`, or none
   * given), else "the clone could not be started". `previous` is the Repository before the
   * attempt, or `null`.
   */
  static failureWhenCloneNotScheduled(
    previous: RepositoryConnection | null,
    settings?: { url: string; integrationBranch: string },
  ): RepositoryFailure {
    const sameSettings =
      settings === undefined ||
      (previous?.url === settings.url && previous.integrationBranch === settings.integrationBranch);
    return previous?.state === 'failed' && previous.failure && sameSettings
      ? previous.failure
      : RepositoryFailure.notStarted();
  }

  /**
   * A Retry: only a `failed` Repository is replaced by a new attempt (with a kept Deploy key,
   * only while it still references that key). Otherwise {@link RepositoryAlreadyConnectedError}.
   */
  restart(attempt: ConnectAttempt): void {
    if (this.state !== 'failed' || attempt.projectId !== this.projectId) {
      throw new RepositoryAlreadyConnectedError();
    }
    if (attempt.keepsDeployKey && this.deployKeySecret !== (attempt.deployKey?.secretRef ?? null)) {
      throw new RepositoryAlreadyConnectedError();
    }
    this.apply(newAttempt(attempt));
    CHANGES.get(this)!.identity = attempt.identity;
  }

  /**
   * A verifiable Repository → `awaiting_host_key` with the retrieved host key awaiting
   * confirmation (the failure is cleared). Otherwise {@link RepositoryNotVerifiableError}.
   */
  awaitHostKey(hostKey: string): void {
    this.assertVerifiable();
    this.apply({ state: 'awaiting_host_key', pendingHostKey: hostKey, failure: null });
  }

  /**
   * The host key awaiting confirmation, when the operator's `fingerprint` is its fingerprint.
   * Throws {@link RepositoryNotVerifiableError} when no host key awaits confirmation and
   * {@link HostKeyFingerprintMismatchError} for another fingerprint.
   */
  confirmedHostKey(fingerprint: string): string {
    const pending = this.state === 'awaiting_host_key' ? this.pendingHostKey : null;
    if (!pending) throw new RepositoryNotVerifiableError(NOT_WAITING_FOR_HOST_KEY);
    if (hostKeyFingerprint(pending) !== fingerprint) throw new HostKeyFingerprintMismatchError();
    return pending;
  }

  /**
   * Starts the clone of a verified SSH Repository: → `connecting`, the failure and any pending
   * host key cleared. Without `confirmed`, from any verifiable state. With it, only from
   * `awaiting_host_key` with exactly that pending host key, which is then pinned. Otherwise
   * {@link RepositoryNotVerifiableError}.
   */
  startVerifiedClone(confirmed: { pendingHostKey: string } | null): void {
    this.assertVerifiable();
    if (
      confirmed &&
      (this.state !== 'awaiting_host_key' || this.pendingHostKey !== confirmed.pendingHostKey)
    ) {
      throw new RepositoryNotVerifiableError();
    }
    this.apply({
      state: 'connecting',
      pendingHostKey: null,
      failure: null,
      ...(confirmed ? { pinnedHostKey: confirmed.pendingHostKey } : {}),
    });
  }

  /** A verifiable Repository → `failed` (its host could not be reached); false if it was not. */
  failVerification(failure: RepositoryFailure): boolean {
    if (!this.isVerifiable) return false;
    this.apply({ state: 'failed', failure, pendingHostKey: null });
    return true;
  }

  /** `connecting` → `ready` with the Clone's commit; false if the state was not `connecting`. */
  completeClone(clone: { headSha: string; fetchedAt: Date }): boolean {
    if (this.state !== 'connecting') return false;
    this.apply({
      state: 'ready',
      headSha: clone.headSha,
      lastFetchedAt: clone.fetchedAt,
      failure: null,
    });
    return true;
  }

  /** `connecting` → `failed`; false if the state was not `connecting`. */
  failClone(failure: RepositoryFailure): boolean {
    if (this.state !== 'connecting') return false;
    this.apply({ state: 'failed', failure });
    return true;
  }

  /**
   * `ready`, or `failed` with a usable Clone → `fetching` (the failure is cleared; the Clone's
   * commit and fetch time are kept). Throws {@link NoUsableCloneError} (`failed` without a
   * Clone) or {@link RepositoryBusyError} (`connecting`, `fetching` and the other states).
   */
  startFetch(): void {
    if (this.state === 'ready' || (this.state === 'failed' && this.hasClone)) {
      this.apply({ state: 'fetching', failure: null });
      return;
    }
    throw this.state === 'failed' ? new NoUsableCloneError() : new RepositoryBusyError();
  }

  /** `fetching` → `ready` with the Clone's commit; false if the state was not `fetching`. */
  completeFetch(clone: { headSha: string; fetchedAt: Date }): boolean {
    if (this.state !== 'fetching') return false;
    this.apply({
      state: 'ready',
      headSha: clone.headSha,
      lastFetchedAt: clone.fetchedAt,
      failure: null,
    });
    return true;
  }

  /**
   * `fetching` → `failed`; false if the state was not `fetching`. With `cloneKept`, the previous
   * commit and fetch time stay; without it (the Clone was removed, `size_limit`) they are
   * cleared, so the Repository has no usable Clone until a Retry.
   */
  failFetch(failure: RepositoryFailure, outcome: { cloneKept: boolean }): boolean {
    if (this.state !== 'fetching') return false;
    this.apply({
      state: 'failed',
      failure,
      ...(outcome.cloneKept ? {} : { headSha: null, lastFetchedAt: null }),
    });
    return true;
  }

  /**
   * The fetch could not be scheduled: `fetching` → what it was before it started (the Clone's
   * commit and fetch time are unchanged). With the failure it had, `failed`, else `ready`. False
   * if the state was not `fetching`.
   */
  revertFetch(previousFailure: RepositoryFailure | null): boolean {
    if (this.state !== 'fetching') return false;
    if (previousFailure) return this.failFetch(previousFailure, { cloneKept: true });
    return this.completeFetch({ headSha: this.headSha!, fetchedAt: this.lastFetchedAt! });
  }

  /**
   * Any state → `disconnecting`: the failure, any pending host key and the Clone's commit and
   * fetch time are cleared (the Clone is about to be removed). Repeating it changes nothing.
   * From then on no transition out of `connecting` or `fetching` applies, so a job still
   * running cannot overwrite it.
   */
  startDisconnect(): void {
    this.apply({
      state: 'disconnecting',
      headSha: null,
      lastFetchedAt: null,
      pendingHostKey: null,
      failure: null,
    });
  }

  /**
   * A `disconnecting` Repository forgets its Deploy key reference, public key and host keys (a
   * Disconnect step, after the secret itself is deleted); false if it is not `disconnecting`.
   */
  forgetDeployKey(): boolean {
    if (this.state !== 'disconnecting') return false;
    this.apply({
      publicKey: null,
      deployKeySecret: null,
      pinnedHostKey: null,
      pendingHostKey: null,
    });
    return true;
  }

  /**
   * The last step of a Disconnect: a `disconnecting` Repository is removed, which frees its
   * remote for another connect. False (and nothing removed) if it is not `disconnecting`.
   */
  finishDisconnect(): boolean {
    if (this.state !== 'disconnecting') return false;
    CHANGES.get(this)!.removed = true;
    return true;
  }

  private stored(): StoredRepositoryConnection {
    return {
      projectId: this.projectId,
      url: this.url,
      integrationBranch: this.integrationBranch,
      state: this.state,
      headSha: this.headSha,
      lastFetchedAt: this.lastFetchedAt,
      failure: this.failure,
      publicKey: this.publicKey,
      deployKeySecret: this.deployKeySecret,
      pinnedHostKey: this.pinnedHostKey,
      pendingHostKey: this.pendingHostKey,
    };
  }

  private apply(patch: Partial<StoredRepositoryConnection>): void {
    Object.assign(CHANGES.get(this)!.fields, patch);
    Object.assign(this, withDerived({ ...this.stored(), ...patch }));
  }
}

/** The stored fields with the ones derived from them: the Clone flag and the fingerprint. */
function withDerived(stored: StoredRepositoryConnection): RepositoryConnectionData {
  const shown = stored.pendingHostKey ?? stored.pinnedHostKey;
  return {
    ...stored,
    hasClone: stored.headSha !== null,
    hostKeyFingerprint: shown === null ? null : hostKeyFingerprint(shown),
  };
}

/** The fields of a new attempt: no Clone, no failure, and the Deploy key if the remote is SSH. */
function newAttempt(attempt: ConnectAttempt): StoredRepositoryConnection {
  return {
    projectId: attempt.projectId,
    url: attempt.url,
    integrationBranch: attempt.integrationBranch,
    state: attempt.deployKey ? 'awaiting_key' : 'connecting',
    headSha: null,
    lastFetchedAt: null,
    failure: null,
    publicKey: attempt.deployKey?.publicKey ?? null,
    deployKeySecret: attempt.deployKey?.secretRef ?? null,
    pinnedHostKey: attempt.deployKey ? (attempt.pinnedHostKey ?? null) : null,
    pendingHostKey: null,
  };
}
