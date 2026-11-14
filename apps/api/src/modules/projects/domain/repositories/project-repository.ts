import type { Project } from '../entities/project.js';
import type { RepositoryConnection, RepositoryFailure } from '../entities/repository.js';
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
 * state transitions live here too. Every transition out of `connecting` or `fetching` is
 * conditional on the stored state still being that state, so a late or repeated write
 * changes nothing. Starting a connect or a fetch is the duplicate guard: only one of them
 * runs per Repository at a time.
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
  findRepository(projectId: string): Promise<RepositoryConnection | null>;

  /**
   * Stores the Repository in state `connecting`: a new one, or a `failed` one replaced by
   * the new attempt. The store, not a prior read, decides conflicts, so concurrent connects
   * cannot both succeed. Throws {@link ProjectNotFoundError},
   * {@link RepositoryAlreadyConnectedError} (a Repository that is not `failed` exists) or
   * {@link RemoteAlreadyConnectedError} (another Project holds the same remote identity).
   */
  beginConnect(record: ConnectRepositoryRecord): Promise<RepositoryConnection>;

  /** `connecting` → `ready` with the Clone's commit; false if the state was not `connecting`. */
  markReady(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean>;

  /** `connecting` → `failed`; false if the state was not `connecting`. */
  markFailed(projectId: string, failure: RepositoryFailure): Promise<boolean>;

  /** Every `connecting` Repository → `failed` (start-up reconciliation); returns how many. */
  failAllConnecting(failure: RepositoryFailure): Promise<number>;

  /**
   * `ready`, or `failed` with a usable Clone → `fetching` (the failure is cleared; the
   * Clone's commit and fetch time are kept), in one conditional write. Throws
   * {@link ProjectNotFoundError}, {@link NoRepositoryError}, {@link RepositoryBusyError}
   * (`connecting` or `fetching`) or {@link NoUsableCloneError}.
   */
  beginFetch(projectId: string): Promise<RepositoryConnection>;

  /** `fetching` → `ready` with the Clone's commit; false if the state was not `fetching`. */
  markFetched(projectId: string, clone: { headSha: string; fetchedAt: Date }): Promise<boolean>;

  /**
   * `fetching` → `failed`; false if the state was not `fetching`. With `cloneKept`, the
   * previous commit and fetch time stay; without it (the Clone was removed, `size_limit`)
   * they are cleared, so the Repository has no usable Clone until a Retry.
   */
  markFetchFailed(
    projectId: string,
    failure: RepositoryFailure,
    outcome: { cloneKept: boolean },
  ): Promise<boolean>;

  /**
   * Every `fetching` Repository → `failed`, Clone kept (start-up reconciliation); returns
   * how many.
   */
  failAllFetching(failure: RepositoryFailure): Promise<number>;

  /**
   * Any state → `disconnecting`, in one write: the failure and the Clone's commit and fetch
   * time are cleared (the Clone is about to be removed). Repeating it on a `disconnecting`
   * Repository changes nothing. From then on no transition out of `connecting` or `fetching`
   * applies, so a job still running cannot overwrite it. Throws {@link ProjectNotFoundError}
   * or {@link NoRepositoryError}.
   */
  beginDisconnect(projectId: string): Promise<RepositoryConnection>;

  /**
   * Deletes the Repository record if it is `disconnecting` (the last step of a Disconnect),
   * which frees its remote for another connect; false if nothing was deleted.
   */
  deleteDisconnecting(projectId: string): Promise<boolean>;

  /** The project ids of every `disconnecting` Repository (start-up resumes their cleanup). */
  listDisconnecting(): Promise<string[]>;
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

/** The project has no Repository. */
export class NoRepositoryError extends Error {
  constructor() {
    super('The project has no repository.');
    this.name = 'NoRepositoryError';
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
