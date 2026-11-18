import type { ConnectAttempt } from '../entities/repository-connection-facts.js';
import type { RepositoryConnection } from '../entities/repository-connection.js';
import type { RepositoryState } from '../value-objects/repository-state.js';

/** DI token for the {@link RepositoryConnectionRepository} adapter. */
export const REPOSITORY_CONNECTION_REPOSITORY = Symbol('REPOSITORY_CONNECTION_REPOSITORY');

/**
 * The Repository connection aggregate's store. A Project has at most one Repository, which
 * refers to its Project by id; the rules are the {@link RepositoryConnection} class's: a use
 * case loads it, calls a method and saves it (backend.md §3 rule 6). Besides `find`, the store
 * offers the locked {@link RepositoryConnectionRepository.change} and the connect that must
 * be one atomic database step. It reads and writes the `repositories` table only: whether the
 * Project exists, and the name of the Project that holds a remote, are asked of
 * `ProjectRepository` by the handler.
 */
export interface RepositoryConnectionRepository {
  /** The project's Repository, or `null` when none is connected. */
  find(projectId: string): Promise<RepositoryConnection | null>;

  /**
   * Stores a Repository for a Connect: a new one ({@link RepositoryConnection.start}), or a
   * `failed` one replaced by the new attempt ({@link RepositoryConnection.restart}, under the
   * row's lock), and returns it. The caller checks that the project exists. Throws
   * {@link RepositoryAlreadyConnectedError} (a Repository that is not `failed` exists, or a
   * kept Deploy key is gone) or {@link RemoteHeldByOtherProjectError} (another Project holds
   * the same remote identity).
   *
   * Atomic operation: a Repository that does not exist yet cannot be locked, so the unique
   * indexes (one Repository per Project, one Project per remote identity) decide simultaneous
   * connects, as they do for a new Project's name.
   */
  connect(attempt: ConnectAttempt): Promise<RepositoryConnection>;

  /**
   * Changes the project's Repository in one transaction: loads it `FOR UPDATE`, calls `mutate`
   * with it, and saves what `mutate` changed ({@link RepositoryConnection.pendingChanges});
   * returns the saved Repository, or `null` when the project has none (`mutate` is then not
   * called). `mutate` is pure: it calls the Repository's methods only and does no I/O; whatever
   * it throws (a domain refusal) rolls the transaction back and reaches the caller. The row
   * lock serializes this change with every other change of the Repository, so a late write of
   * a job waits for a Disconnect and then finds the state it checks as the Disconnect left it.
   */
  change(
    projectId: string,
    mutate: (repository: RepositoryConnection) => void,
  ): Promise<RepositoryConnection | null>;

  /** The project ids of every Repository in this state (start-up resumes or fails them). */
  listIdsInState(state: RepositoryState): Promise<string[]>;

  /**
   * The secret store reference of every Repository's Deploy key, in any state (a
   * `disconnecting` one still holds its key until its cleanup forgets it). The orphan sweep
   * deletes only Deploy keys outside this list (Issue #76).
   */
  listDeployKeySecretRefs(): Promise<string[]>;
}
