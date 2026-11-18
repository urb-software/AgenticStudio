import { NoUsableCloneError, RepositoryBusyError } from '../errors/repository-connection-errors.js';
import { isRepositoryState, type RepositoryState } from './repository-state.js';
import type { LifecycleFacts } from './lifecycle-facts.js';
import type { StorableConnection } from './storable-connection.js';

/**
 * The lifecycle of a Repository connection: its starting state, which operations each state accepts
 * (the guards) and which state and field combinations a store may hold. Which transitions are
 * allowed lives here only.
 */
export class RepositoryLifecycle {
  private constructor(private readonly facts: LifecycleFacts) {}

  static of(facts: LifecycleFacts): RepositoryLifecycle {
    return new RepositoryLifecycle(facts);
  }

  static initialState(hasDeployKey: boolean): RepositoryState {
    return hasDeployKey ? 'awaiting_key' : 'connecting';
  }

  /**
   * Throws {@link TypeError} for a combination of state and fields that a store should never
   * hold (the database's CHECK constraints say the same).
   */
  static assertStorable(stored: StorableConnection): void {
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

  get isDisconnecting(): boolean {
    return this.facts.state === 'disconnecting';
  }

  get isFailed(): boolean {
    return this.facts.state === 'failed';
  }

  get isAwaitingHostKey(): boolean {
    return this.facts.state === 'awaiting_host_key';
  }

  /**
   * Whether "Verify and clone" applies: an SSH Repository without a Clone that is `awaiting_key`,
   * `awaiting_host_key` or `failed`.
   */
  get isVerifiable(): boolean {
    const { state, hasClone, hasDeployKey } = this.facts;
    return (
      hasDeployKey &&
      !hasClone &&
      (state === 'awaiting_key' || state === 'awaiting_host_key' || state === 'failed')
    );
  }

  get acceptsRetry(): boolean {
    return this.facts.state === 'failed';
  }

  get acceptsCloneResult(): boolean {
    return this.facts.state === 'connecting';
  }

  get acceptsFetchResult(): boolean {
    return this.facts.state === 'fetching';
  }

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
