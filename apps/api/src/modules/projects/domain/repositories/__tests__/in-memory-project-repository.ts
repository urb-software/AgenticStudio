import type { Project } from '../../entities/project.js';
import type { RepositoryConnection, RepositoryFailure } from '../../entities/repository.js';
import type { ProjectName } from '../../value-objects/project-name.js';
import {
  type ConnectRepositoryRecord,
  ProjectNotFoundError,
  type ProjectRepository,
  RemoteAlreadyConnectedError,
  RepositoryAlreadyConnectedError,
} from '../project-repository.js';

/**
 * In-memory adapter of {@link ProjectRepository} for handler tests, with the same rules as
 * the database: one Repository per project, one project per remote identity, only a `failed`
 * Repository is replaced, and transitions out of `connecting` are conditional.
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

  async failAllConnecting(failure: RepositoryFailure): Promise<number> {
    let count = 0;
    for (const projectId of this.repositories.keys()) {
      if (await this.markFailed(projectId, failure)) count += 1;
    }
    return count;
  }

  private transition(projectId: string, change: (repository: RepositoryConnection) => void) {
    const repository = this.repositories.get(projectId);
    if (repository?.state !== 'connecting') return Promise.resolve(false);
    change(repository);
    return Promise.resolve(true);
  }
}
