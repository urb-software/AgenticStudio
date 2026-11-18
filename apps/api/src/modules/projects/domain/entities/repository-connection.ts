import { HostKey } from '../value-objects/host-key.js';
import { KnownHostName } from '../value-objects/known-host-name.js';
import type { ConnectAttempt, RepositoryChanges } from './repository-connection-facts.js';
import {
  HostKeyFingerprintMismatchError,
  RepositoryAlreadyConnectedError,
  RepositoryNotVerifiableError,
} from '../errors/repository-connection-errors.js';
import type { RepositoryConnectionSnapshot } from './repository-connection-snapshot.js';
import type {
  RepositoryConnectionData,
  StoredRepositoryConnection,
} from './repository-connection-data.js';
import { RepositoryFailure } from '../value-objects/repository-failure.js';
import { RepositoryLifecycle } from '../value-objects/repository-lifecycle.js';

/**
 * The Repository connected to a Project: it owns its lifecycle, and the store saves
 * {@link RepositoryConnection.pendingChanges} in one transaction under the row lock.
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

  readonly #changes: RepositoryChanges;

  private constructor(stored: StoredRepositoryConnection, changes: RepositoryChanges) {
    Object.assign(this, RepositoryConnection.withDerived(stored));
    this.#changes = changes;
  }

  /**
   * A new Repository for a Connect: `connecting`, or `awaiting_key` with a Deploy key. A kept
   * key (`keepsDeployKey`) belongs to a Repository that must still exist, so it is refused here
   * with {@link RepositoryAlreadyConnectedError}.
   */
  static start(attempt: ConnectAttempt): RepositoryConnection {
    if (attempt.keepsDeployKey) throw new RepositoryAlreadyConnectedError();
    const stored = RepositoryConnection.newAttempt(attempt);
    return new RepositoryConnection(stored, { fields: { ...stored }, identity: attempt.identity });
  }

  /**
   * A Repository as storage holds it. Throws {@link TypeError} for state the store should never
   * hold (the database's CHECK constraints say the same).
   */
  static restore(stored: StoredRepositoryConnection): RepositoryConnection {
    RepositoryLifecycle.restore(stored);
    return new RepositoryConnection({ ...stored }, { fields: {} });
  }

  snapshot(): RepositoryConnectionSnapshot {
    return RepositoryConnection.withDerived(this.stored());
  }

  pendingChanges(): RepositoryChanges {
    const pending = this.#changes;
    return { ...pending, fields: { ...pending.fields } };
  }

  /**
   * Which Git job runs for the Repository's state: `clone` while `connecting`, `fetch` while
   * `fetching`; `null` otherwise (a job left over from before a restart does nothing).
   */
  get pendingOperation(): 'clone' | 'fetch' | null {
    return this.lifecycle.pendingOperation;
  }

  get isFailed(): boolean {
    return this.lifecycle.isFailed;
  }

  get isDisconnecting(): boolean {
    return this.lifecycle.isDisconnecting;
  }

  get isVerifiable(): boolean {
    return this.lifecycle.isVerifiable;
  }

  /** Throws {@link RepositoryNotVerifiableError} unless {@link isVerifiable}. */
  assertVerifiable(): void {
    if (!this.isVerifiable) throw new RepositoryNotVerifiableError();
  }

  /** The Deploy key a Retry of a failed Repository keeps, or `null` for any other Repository. */
  get retainedDeployKey(): { publicKey: string; secretRef: string } | null {
    return this.lifecycle.isFailed && this.deployKeySecret && this.publicKey
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
    const host = KnownHostName.of(this.url);
    return host !== null && host.value === KnownHostName.of(url)?.value ? this.pinnedHostKey : null;
  }

  /**
   * A Retry: only a `failed` Repository is replaced by a new attempt (with a kept Deploy key,
   * only while it still references that key). Otherwise {@link RepositoryAlreadyConnectedError}.
   */
  restart(attempt: ConnectAttempt): void {
    if (!this.lifecycle.acceptsRetry || attempt.projectId !== this.projectId) {
      throw new RepositoryAlreadyConnectedError();
    }
    if (attempt.keepsDeployKey && this.deployKeySecret !== (attempt.deployKey?.secretRef ?? null)) {
      throw new RepositoryAlreadyConnectedError();
    }
    this.apply(RepositoryConnection.newAttempt(attempt));
    this.#changes.identity = attempt.identity;
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
    const pending = this.lifecycle.isAwaitingHostKey ? this.pendingHostKey : null;
    if (!pending) throw RepositoryNotVerifiableError.noHostKeyAwaiting();
    if (HostKey.of(pending).fingerprint !== fingerprint)
      throw new HostKeyFingerprintMismatchError();
    return pending;
  }

  /**
   * Starts the clone of a verified SSH Repository: → `connecting`, clearing the failure and any pending
   * host key. Without `confirmed`, from any verifiable state. With it, only from `awaiting_host_key` with
   * exactly that host key, which is then pinned. Otherwise {@link RepositoryNotVerifiableError}.
   */
  startVerifiedClone(confirmed: { pendingHostKey: string } | null): void {
    this.assertVerifiable();
    if (
      confirmed &&
      (!this.lifecycle.isAwaitingHostKey || this.pendingHostKey !== confirmed.pendingHostKey)
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
    if (!this.lifecycle.acceptsCloneResult) return false;
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
    if (!this.lifecycle.acceptsCloneResult) return false;
    this.apply({ state: 'failed', failure });
    return true;
  }

  /**
   * `ready`, or `failed` with a usable Clone → `fetching` (the failure is cleared; the Clone's
   * commit and fetch time are kept). Throws `NoUsableCloneError` (`failed` without a
   * Clone) or `RepositoryBusyError` (`connecting`, `fetching` and the other states).
   */
  startFetch(): void {
    const refusal = this.lifecycle.fetchRefusal();
    if (refusal) throw refusal;
    this.apply({ state: 'fetching', failure: null });
  }

  /** `fetching` → `ready` with the Clone's commit; false if the state was not `fetching`. */
  completeFetch(clone: { headSha: string; fetchedAt: Date }): boolean {
    if (!this.lifecycle.acceptsFetchResult) return false;
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
    if (!this.lifecycle.acceptsFetchResult) return false;
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
    if (!this.lifecycle.acceptsFetchResult) return false;
    if (previousFailure) return this.failFetch(previousFailure, { cloneKept: true });
    return this.completeFetch({ headSha: this.headSha!, fetchedAt: this.lastFetchedAt! });
  }

  /**
   * Any state → `disconnecting`, clearing the failure, pending host key and the Clone's commit and
   * fetch time. Idempotent; no transition out of `connecting` or `fetching` applies afterwards, so a
   * running job cannot overwrite it.
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
    if (!this.lifecycle.acceptsCleanup) return false;
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
    if (!this.lifecycle.acceptsCleanup) return false;
    this.#changes.removed = true;
    return true;
  }

  private get lifecycle(): RepositoryLifecycle {
    return RepositoryLifecycle.of({
      state: this.state,
      hasClone: this.hasClone,
      hasDeployKey: this.deployKeySecret !== null,
    });
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
    Object.assign(this.#changes.fields, patch);
    Object.assign(this, RepositoryConnection.withDerived({ ...this.stored(), ...patch }));
  }

  private static withDerived(stored: StoredRepositoryConnection): RepositoryConnectionData {
    const shown = stored.pendingHostKey ?? stored.pinnedHostKey;
    return {
      ...stored,
      hasClone: stored.headSha !== null,
      hostKeyFingerprint: shown === null ? null : HostKey.of(shown).fingerprint,
    };
  }

  private static newAttempt(attempt: ConnectAttempt): StoredRepositoryConnection {
    return {
      projectId: attempt.projectId,
      url: attempt.url,
      integrationBranch: attempt.integrationBranch,
      state: RepositoryLifecycle.start(Boolean(attempt.deployKey)).state,
      headSha: null,
      lastFetchedAt: null,
      failure: null,
      publicKey: attempt.deployKey?.publicKey ?? null,
      deployKeySecret: attempt.deployKey?.secretRef ?? null,
      pinnedHostKey: attempt.deployKey ? (attempt.pinnedHostKey ?? null) : null,
      pendingHostKey: null,
    };
  }
}
