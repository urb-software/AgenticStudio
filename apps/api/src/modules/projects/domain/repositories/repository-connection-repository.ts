import type { ConnectAttempt } from '../entities/repository-connection-facts.js';
import type { RepositoryConnection } from '../entities/repository-connection.js';
import type { RepositoryState } from '../value-objects/repository-state.js';

export const REPOSITORY_CONNECTION_REPOSITORY = Symbol('REPOSITORY_CONNECTION_REPOSITORY');

/**
 * The Repository connection aggregate's store: the `repositories` table only. The handler asks
 * `ProjectRepository` whether the Project exists and which Project holds a remote.
 */
export interface RepositoryConnectionRepository {
  /** The project's Repository, or `null` when none is connected. */
  find(projectId: string): Promise<RepositoryConnection | null>;

  /**
   * Stores a Repository for a Connect: a new one, or a `failed` one replaced under its row lock.
   * Throws {@link RepositoryAlreadyConnectedError} (not `failed`, or a kept Deploy key is gone) or
   * {@link RemoteHeldByOtherProjectError}. Atomic: the unique indexes decide simultaneous connects.
   */
  connect(attempt: ConnectAttempt): Promise<RepositoryConnection>;

  /**
   * Changes the project's Repository in one transaction: loads it `FOR UPDATE`, calls `mutate`, saves
   * what changed and returns it, or `null` (without calling `mutate`) when there is none. `mutate` is
   * pure; what it throws rolls back. The row lock serializes it with every other change.
   */
  change(
    projectId: string,
    mutate: (repository: RepositoryConnection) => void,
  ): Promise<RepositoryConnection | null>;

  /** The project ids of every Repository in this state (start-up resumes or fails them). */
  listIdsInState(state: RepositoryState): Promise<string[]>;

  /**
   * The secret store reference of every Deploy key, in any state (a `disconnecting` Repository still
   * holds its key); the orphan sweep deletes only keys outside this list.
   */
  listDeployKeySecretRefs(): Promise<string[]>;
}
