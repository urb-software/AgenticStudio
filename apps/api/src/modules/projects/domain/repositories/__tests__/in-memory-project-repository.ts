import type { Project } from '../../entities/project.js';
import type { RepositoryConnection, RepositoryFailure } from '../../entities/repository.js';
import type { ProjectName } from '../../value-objects/project-name.js';
import {
  type ConnectRepositoryRecord,
  NoRepositoryError,
  NoUsableCloneError,
  ProjectNotFoundError,
  type ProjectRepository,
  RemoteAlreadyConnectedError,
  RepositoryAlreadyConnectedError,
  RepositoryBusyError,
} from '../project-repository.js';

/**
 * In-memory adapter of {@link ProjectRepository} for handler tests, with the same rules as
 * the database: one Repository per project, one project per remote identity, only a `failed`
 * Repository is replaced, a fetch starts only from `ready` or `failed` with a Clone,
 * transitions out of `connecting` and `fetching` are conditional, and only a `disconnecting`
 * Repository is deleted.
 */
export class InMemoryProjectRepository implements ProjectRepository {
  readonly projects = new Map<string, Project>();
  readonly repositories = new Map<string, RepositoryConnection & { identity: string }>();

  addProject(id: string, name: string): Project {
    const project = { id, name, createdAt: new Date('2026-11-13T10:00:00.000Z') };
    this.projects.set(id, project);
    return project;
  }

  add(name: ProjectName): Promise<Project> {
    void name;
    return Promise.reject(new Error('not used by these tests'));
  }

  listNewestFirst(): Promise<Project[]> {
    return Promise.resolve([...this.projects.values()]);
  }

  findById(id: string): Promise<Project | null> {
    return Promise.resolve(this.projects.get(id) ?? null);
  }

  findRepository(projectId: string): Promise<RepositoryConnection | null> {
    const stored = this.repositories.get(projectId);
    if (!stored) return Promise.resolve(null);
    const { identity, ...repository } = stored;
    void identity; // stored for the uniqueness rule, not part of a RepositoryConnection
    return Promise.resolve(structuredClone(repository));
  }

  async beginConnect(record: ConnectRepositoryRecord): Promise<RepositoryConnection> {
    if (!this.projects.has(record.projectId)) throw new ProjectNotFoundError();
    const existing = this.repositories.get(record.projectId);
    if (existing && existing.state !== 'failed') throw new RepositoryAlreadyConnectedError();
    const owner = [...this.repositories.values()].find(
      (repository) =>
        repository.identity === record.identity && repository.projectId !== record.projectId,
    );
    if (owner) throw new RemoteAlreadyConnectedError(this.projects.get(owner.projectId)!.name);
    this.repositories.set(record.projectId, {
      projectId: record.projectId,
      url: record.url,
      identity: record.identity,
      integrationBranch: record.integrationBranch,
      state: 'connecting',
      hasClone: false,
      headSha: null,
      lastFetchedAt: null,
      failure: null,
      publicKey: null,
      deployKeySecret: null,
      pinnedHostKey: null,
      pendingHostKey: null,
      hostKeyFingerprint: null,
    });
    return (await this.findRepository(record.projectId))!;
  }

  markReady(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean> {
    return this.transition(projectId, (repository) => {
      repository.state = 'ready';
      repository.hasClone = true;
      repository.headSha = clone.headSha;
      repository.lastFetchedAt = clone.fetchedAt;
    });
  }

  markFailed(projectId: string, failure: RepositoryFailure): Promise<boolean> {
    return this.transition(projectId, (repository) => {
      repository.state = 'failed';
      repository.failure = failure;
    });
  }

  async beginFetch(projectId: string): Promise<RepositoryConnection> {
    if (!this.projects.has(projectId)) throw new ProjectNotFoundError();
    const repository = this.repositories.get(projectId);
    if (!repository) throw new NoRepositoryError();
    if (repository.state === 'connecting' || repository.state === 'fetching') {
      throw new RepositoryBusyError();
    }
    if (!repository.hasClone) throw new NoUsableCloneError();
    repository.state = 'fetching';
    repository.failure = null;
    return (await this.findRepository(projectId))!;
  }

  markFetched(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean> {
    return this.transition(
      projectId,
      (repository) => {
        repository.state = 'ready';
        repository.headSha = clone.headSha;
        repository.lastFetchedAt = clone.fetchedAt;
      },
      'fetching',
    );
  }

  markFetchFailed(
    projectId: string,
    failure: RepositoryFailure,
    { cloneKept }: { cloneKept: boolean },
  ): Promise<boolean> {
    return this.transition(
      projectId,
      (repository) => {
        repository.state = 'failed';
        repository.failure = failure;
        if (!cloneKept) {
          repository.hasClone = false;
          repository.headSha = null;
          repository.lastFetchedAt = null;
        }
      },
      'fetching',
    );
  }

  async failAllFetching(failure: RepositoryFailure): Promise<number> {
    let count = 0;
    for (const projectId of this.repositories.keys()) {
      if (await this.markFetchFailed(projectId, failure, { cloneKept: true })) count += 1;
    }
    return count;
  }

  async failAllConnecting(failure: RepositoryFailure): Promise<number> {
    let count = 0;
    for (const projectId of this.repositories.keys()) {
      if (await this.markFailed(projectId, failure)) count += 1;
    }
    return count;
  }

  async beginDisconnect(projectId: string): Promise<RepositoryConnection> {
    if (!this.projects.has(projectId)) throw new ProjectNotFoundError();
    const repository = this.repositories.get(projectId);
    if (!repository) throw new NoRepositoryError();
    repository.state = 'disconnecting';
    repository.failure = null;
    repository.hasClone = false;
    repository.headSha = null;
    repository.lastFetchedAt = null;
    return (await this.findRepository(projectId))!;
  }

  deleteDisconnecting(projectId: string): Promise<boolean> {
    if (this.repositories.get(projectId)?.state !== 'disconnecting') return Promise.resolve(false);
    this.repositories.delete(projectId);
    return Promise.resolve(true);
  }

  listDisconnecting(): Promise<string[]> {
    return Promise.resolve(
      [...this.repositories.values()]
        .filter((repository) => repository.state === 'disconnecting')
        .map((repository) => repository.projectId),
    );
  }

  private transition(
    projectId: string,
    change: (repository: RepositoryConnection) => void,
    from: 'connecting' | 'fetching' = 'connecting',
  ) {
    const repository = this.repositories.get(projectId);
    if (repository?.state !== from) return Promise.resolve(false);
    change(repository);
    return Promise.resolve(true);
  }
}
