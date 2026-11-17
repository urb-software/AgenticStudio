import { NoUsableCloneError, RepositoryBusyError } from './repository-connection-errors.js';
import type { StoredRepositoryConnection } from './repository-connection-snapshot.js';
import { isRepositoryState, type RepositoryState } from './repository-state.js';

/** What the lifecycle needs to know of a Repository besides its state. */
export interface LifecycleFacts {
  readonly state: RepositoryState;
  /** Whether a usable Clone exists. */
  readonly hasClone: boolean;
  /** Whether the Repository holds a Deploy key (it is an SSH Repository). */
  readonly hasDeployKey: boolean;
}

/**
 * The lifecycle of a Repository connection: which state it starts in, which operations each
 * state accepts (the guards), and which combinations of state and fields a store may hold.
 * The `RepositoryConnection` class asks it before every transition and sets the target state
 * in its own methods, so which state allows which transition lives here and nowhere else:
 *
 * - `awaiting_key` / `awaiting_host_key` / `failed` without a Clone of an SSH Repository
 *   → verified (`connecting`) or `awaiting_host_key`;
 * - `connecting` → `ready` or `failed` (a clone result);
 * - `ready`, or `failed` with a Clone → `fetching` → `ready` or `failed` (a fetch result);
 * - `failed` → a new attempt (a Retry);
 * - any state → `disconnecting` → forgets its key material → removed.
 *
 * It holds no data of its own: it is built from the state and the facts it is asked about.
 */
export class RepositoryLifecycle {
  private constructor(private readonly facts: LifecycleFacts) {}

  static of(facts: LifecycleFacts): RepositoryLifecycle {
    return new RepositoryLifecycle(facts);
  }

  /** The state of a new attempt: `awaiting_key` with a Deploy key, otherwise `connecting`. */
  static initialState(hasDeployKey: boolean): RepositoryState {
    return hasDeployKey ? 'awaiting_key' : 'connecting';
  }

  /**
   * Throws {@link TypeError} for a combination of state and fields that a store should never
   * hold (the database's CHECK constraints say the same).
   */
  static assertStorable(stored: StoredRepositoryConnection): void {
    const { state } = stored;
    if (!isRepositoryState(state)) {
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
  }

  /**
   * Which Git job runs for the state: `clone` while `connecting`, `fetch` while `fetching`;
   * `null` otherwise (a job left over from before a restart does nothing).
   */
  get pendingOperation(): 'clone' | 'fetch' | null {
    if (this.facts.state === 'connecting') return 'clone';
    if (this.facts.state === 'fetching') return 'fetch';
    return null;
  }

  /** Whether the operator disconnected it and its data is still being removed. */
  get isDisconnecting(): boolean {
    return this.facts.state === 'disconnecting';
  }

  /** Whether the last connect or fetch failed. */
  get isFailed(): boolean {
    return this.facts.state === 'failed';
  }

  /** Whether the retrieved host key awaits the operator's confirmation. */
  get isAwaitingHostKey(): boolean {
    return this.facts.state === 'awaiting_host_key';
  }

  /**
   * Whether "Verify and clone" applies (Issue #62): an SSH Repository (it has a Deploy key)
   * without a Clone that is `awaiting_key`, `awaiting_host_key`, or `failed` (Retry keeps the
   * Deploy key).
   */
  get isVerifiable(): boolean {
    const { state, hasClone, hasDeployKey } = this.facts;
    return (
      hasDeployKey &&
      !hasClone &&
      (state === 'awaiting_key' || state === 'awaiting_host_key' || state === 'failed')
    );
  }

  /** Whether a Retry (a new attempt) replaces it: only a `failed` Repository. */
  get acceptsRetry(): boolean {
    return this.facts.state === 'failed';
  }

  /** Whether the result of a clone applies: only while `connecting`. */
  get acceptsCloneResult(): boolean {
    return this.facts.state === 'connecting';
  }

  /** Whether the result of a fetch applies: only while `fetching`. */
  get acceptsFetchResult(): boolean {
    return this.facts.state === 'fetching';
  }

  /** Whether its Deploy key material may be forgotten and its record removed: `disconnecting`. */
  get acceptsCleanup(): boolean {
    return this.facts.state === 'disconnecting';
  }

  /**
   * Why a fetch cannot start, or `null` when it can (`ready`, or `failed` with a usable Clone):
   * {@link NoUsableCloneError} for `failed` without a Clone, {@link RepositoryBusyError} for
   * `connecting`, `fetching` and the other states.
   */
  fetchRefusal(): NoUsableCloneError | RepositoryBusyError | null {
    const { state, hasClone } = this.facts;
    if (state === 'ready' || (state === 'failed' && hasClone)) return null;
    return state === 'failed' ? new NoUsableCloneError() : new RepositoryBusyError();
  }
}
