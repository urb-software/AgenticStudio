import type { Project } from '../value-objects/project.js';
import type {
  ConnectAttempt,
  RepositoryConnection,
  RepositoryState,
} from '../entities/repository.js';
import type { ProjectName } from '../value-objects/project-name.js';

/** DI token for the {@link ProjectRepository} adapter. */
export const PROJECT_REPOSITORY = Symbol('PROJECT_REPOSITORY');

/**
 * The Project aggregate's store. A Project owns at most one Repository, whose rules are the
 * {@link RepositoryConnection} class's: a use case loads it, calls a method and saves it
 * (backend.md §3 rule 6). Besides `findRepository`, the store offers the locked
 * {@link ProjectRepository.change} and the operations that must be one atomic database step.
 */
export interface ProjectRepository {
  /**
   * Persists a new project; the store assigns its id and creation time. Throws
   * {@link ProjectNameTakenError} when a project with the same `uniquenessKey` exists,
   * also when a concurrent request created it first.
   *
   * Atomic operation: the unique index on the normalized name decides a simultaneous create;
   * there is no row to lock before it exists.
   */
  add(name: ProjectName): Promise<Project>;

  /** Every project, newest first: by creation time, then by id for equal times. */
  listNewestFirst(): Promise<Project[]>;

  /** The project with this id, or `null`. */
  findById(id: string): Promise<Project | null>;

  /** The project's Repository, or `null` when none is connected. */
  findRepository(projectId: string): Promise<RepositoryConnection | null>;

  /**
   * Stores a Repository for a Connect: a new one ({@link RepositoryConnection.start}), or a
   * `failed` one replaced by the new attempt ({@link RepositoryConnection.restart}, under the
   * row's lock), and returns it. Throws {@link ProjectNotFoundError},
   * {@link RepositoryAlreadyConnectedError} (a Repository that is not `failed` exists, or a
   * kept Deploy key is gone) or {@link RemoteAlreadyConnectedError} (another Project holds the
   * same remote identity).
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
