import type { Project } from '../entities/project.js';
import type { Repository, RepositoryFailure } from '../entities/repository.js';
import type { ProjectName } from '../value-objects/project-name.js';

/** DI token for the {@link ProjectRepository} adapter. */
export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

/** What a Connect stores before the Clone is made. */
export interface ConnectRepositoryRecord {
  projectId: string;
  /** The URL as entered (trimmed). */
  url: string;
  /** The remote's identity (`remoteIdentity`); unique across Projects. */
  identity: string;
  integrationBranch: string;
}

/**
 * The Project aggregate's store. A Project owns at most one Repository, so the Repository's
 * state transitions live here too. Every transition out of `connecting` is conditional on
 * the stored state still being `connecting`, so a late or repeated write changes nothing.
 */
export interface ProjectRepository {
  /**
   * Persists a new project; the store assigns its id and creation time. Throws
   * {@link ProjectNameTakenError} when a project with the same `uniquenessKey` exists,
   * also when a concurrent request created it first.
   */
  add(name: ProjectName): Promise<Project>;

  /** Every project, newest first: by creation time, then by id for equal times. */
  listNewestFirst(): Promise<Project[]>;

  /** The project with this id, or `null`. */
  findById(id: string): Promise<Project | null>;

  /** The project's Repository, or `null` when none is connected. */
  findRepository(projectId: string): Promise<Repository | null>;

  /**
   * Stores the Repository in state `connecting`: a new one, or a `failed` one replaced by
   * the new attempt. The store, not a prior read, decides conflicts, so concurrent connects
   * cannot both succeed. Throws {@link ProjectNotFoundError},
   * {@link RepositoryAlreadyConnectedError} (a Repository that is not `failed` exists) or
   * {@link RemoteAlreadyConnectedError} (another Project holds the same remote identity).
   */
  beginConnect(record: ConnectRepositoryRecord): Promise<Repository>;

  /** `connecting` → `ready` with the Clone's commit; false if the state was not `connecting`. */
  markReady(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean>;

  /** `connecting` → `failed`; false if the state was not `connecting`. */
  markFailed(projectId: string, failure: RepositoryFailure): Promise<boolean>;

  /** Every `connecting` Repository → `failed` (start-up reconciliation); returns how many. */
  failAllConnecting(failure: RepositoryFailure): Promise<number>;
}

/** Another project already has this name (compared by `ProjectName.uniquenessKey`). */
export class ProjectNameTakenError extends Error {
  constructor() {
    super('A project with this name already exists.');
    this.name = 'ProjectNameTakenError';
  }
}

/** No project has this id. */
export class ProjectNotFoundError extends Error {
  constructor() {
    super('The project does not exist.');
    this.name = 'ProjectNotFoundError';
  }
}

/** The project already has a Repository that is connecting or connected. */
export class RepositoryAlreadyConnectedError extends Error {
  constructor() {
    super('The project already has a repository.');
    this.name = 'RepositoryAlreadyConnectedError';
  }
}

/** The same remote is connected to another project, named here for the operator. */
export class RemoteAlreadyConnectedError extends Error {
  constructor(readonly projectName: string) {
    super(`Already connected to ${projectName}`);
    this.name = 'RemoteAlreadyConnectedError';
  }
}
