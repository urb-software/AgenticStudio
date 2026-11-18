import { type ConnectAttempt } from '../../entities/repository-connection-facts.js';
import {
  RepositoryAlreadyConnectedError,
  RemoteHeldByOtherProjectError,
} from '../../errors/repository-connection-errors.js';
import { RepositoryConnection } from '../../entities/repository-connection.js';
import { type RepositoryState } from '../../value-objects/repository-state.js';
import { type StoredRepositoryConnection } from '../../entities/repository-connection-data.js';
import { RepositoryFailure } from '../../value-objects/repository-failure.js';
import { type RepositoryConnectionRepository } from '../repository-connection-repository.js';

/** What the in-memory store keeps of a Repository, and the remote's identity beside it. */
export type StoredRepository = StoredRepositoryConnection & { identity: string };

/**
 * In-memory adapter of {@link RepositoryConnectionRepository} for handler tests, with the same
 * rules as the database: one Repository per project, one project per remote identity, and a
 * change that throws saves nothing (the database rolls the transaction back). The rules of a
 * Repository are the {@link RepositoryConnection} class's, as in the database adapter. Like it,
 * it stores no derived field (`hasClone`, the host key fingerprint) and does not know the
 * Projects: the handler checks that the project exists.
 */
export class InMemoryRepositoryConnectionRepository implements RepositoryConnectionRepository {
  readonly repositories = new Map<string, StoredRepository>();

  find(projectId: string): Promise<RepositoryConnection | null> {
    return Promise.resolve(this.load(projectId));
  }

  async connect(attempt: ConnectAttempt): Promise<RepositoryConnection> {
    const owner = [...this.repositories.values()].find(
      (stored) => stored.identity === attempt.identity && stored.projectId !== attempt.projectId,
    );
    const conflict = () =>
      owner
        ? new RemoteHeldByOtherProjectError(owner.projectId)
        : new RepositoryAlreadyConnectedError();
    const existing = this.load(attempt.projectId);
    let connection: RepositoryConnection;
    try {
      if (existing) {
        existing.restart(attempt);
        connection = existing;
      } else {
        connection = RepositoryConnection.start(attempt);
      }
    } catch (error) {
      if (error instanceof RepositoryAlreadyConnectedError) throw conflict();
      throw error;
    }
    if (owner) throw conflict();
    this.save(connection, attempt.identity);
    return this.load(attempt.projectId)!;
  }

  change(
    projectId: string,
    mutate: (repository: RepositoryConnection) => void,
  ): Promise<RepositoryConnection | null> {
    const repository = this.load(projectId);
    if (!repository) return Promise.resolve(null);
    mutate(repository);
    this.save(repository);
    return Promise.resolve(this.repositories.has(projectId) ? this.load(projectId) : repository);
  }

  listIdsInState(state: RepositoryState): Promise<string[]> {
    return Promise.resolve(
      [...this.repositories.values()]
        .filter((stored) => stored.state === state)
        .map((stored) => stored.projectId),
    );
  }

  listDeployKeySecretRefs(): Promise<string[]> {
    return Promise.resolve(
      [...this.repositories.values()].flatMap((stored) =>
        stored.deployKeySecret === null ? [] : [stored.deployKeySecret],
      ),
    );
  }

  private load(projectId: string): RepositoryConnection | null {
    const stored = this.repositories.get(projectId);
    if (!stored) return null;
    const { identity, ...repository } = stored;
    void identity; // stored for the uniqueness rule, not part of a RepositoryConnection
    const { failure } = repository;
    return RepositoryConnection.restore({
      ...structuredClone({ ...repository, failure: null }),
      failure:
        failure && RepositoryFailure.of(failure.code, failure.detail, failure.remoteDefaultBranch),
    });
  }

  /** Saves what the Repository changed: its fields, its identity, or its removal. */
  private save(repository: RepositoryConnection, identity?: string): void {
    const changes = repository.pendingChanges();
    const { projectId } = repository;
    if (changes.removed) {
      this.repositories.delete(projectId);
      return;
    }
    const stored = this.repositories.get(projectId);
    const { hasClone, hostKeyFingerprint, ...fields } = repository.snapshot();
    void hasClone;
    void hostKeyFingerprint;
    this.repositories.set(projectId, {
      ...fields,
      identity: changes.identity ?? identity ?? stored!.identity,
    });
  }
}
