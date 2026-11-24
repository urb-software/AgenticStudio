import type { PreviewOperation } from '../entities/preview-operation.js';
import type { LostControllerRule } from '../value-objects/lost-controller-rule.js';
import type { OverdueBuildRule } from '../value-objects/overdue-build-rule.js';
import type { UnclaimedOperationRule } from '../value-objects/unclaimed-operation-rule.js';

export const PREVIEW_OPERATION_REPOSITORY = Symbol('PREVIEW_OPERATION_REPOSITORY');

/** What a Project's Preview state is derived from. */
export interface PreviewReadModel {
  /** The newest build by request time, or `null` when the Project never asked for one. */
  latestBuild: PreviewOperation | null;
  /**
   * The newest finished operation that changes what runs (`PreviewRunningRule`), by finish time
   * with ties broken by id, or `null`.
   */
  runningChange: PreviewOperation | null;
  /** The newest stop or data removal by request time, or `null` when the Project never asked for one. */
  latestChange: PreviewOperation | null;
}

/** A Project that takes a place of the running limit. */
export interface PreviewOccupation {
  projectId: string;
  state: 'building' | 'running';
}

/** What removing a Project's Preview on Disconnect decides from (`PreviewDisconnectRule`). */
export interface PreviewDisconnectReadModel {
  /** How many operations the Project has. */
  operations: number;
  /** Whether any build was ever claimed by a controller. */
  buildEverClaimed: boolean;
  /** The newest operation by request time, or `null` for none. */
  newest: { kind: string; status: string } | null;
  /** How many operations are requested or claimed. */
  activeOperations: number;
  /** A data removal is requested or claimed. */
  removalActive: boolean;
}

/** What `decide` of {@link PreviewOperationRepository.request} chooses from, read under the lock. */
export interface PreviewRequestFacts {
  preview: PreviewReadModel;
  /** The Projects that take a place of the running limit (`PreviewRunningLimitRule`). */
  occupying: readonly PreviewOccupation[];
}

export interface PreviewOperationRepository {
  /**
   * Stores a new operation; the caller checked that its Project exists. A unique index is the
   * backstop: `PreviewBuildRunningError` for a second active build, `PreviewBusyError` for a
   * second active stop or data removal.
   */
  add(operation: PreviewOperation): Promise<void>;

  /**
   * One transaction under one lock for every operator request: reads the facts, calls the pure
   * `decide` and inserts what it returns. What `decide` throws rolls back; requests of different
   * Projects are serialized, so the running limit holds. It throws what {@link add} throws.
   */
  request(
    projectId: string,
    decide: (facts: PreviewRequestFacts) => PreviewOperation[],
  ): Promise<PreviewOperation[]>;

  /** The Projects that take a place of the running limit, by the statement `PreviewRunningLimitRule` pairs with. */
  findOccupyingProjects(): Promise<PreviewOccupation[]>;

  /** The Projects `StateCheckRule` selects: their newest operation is a build lost with the Preview unknown. */
  findStateCheckProjects(): Promise<string[]>;

  /** What removing the Project's Preview on Disconnect decides from (`PreviewDisconnectRule`). */
  findDisconnectFacts(projectId: string): Promise<PreviewDisconnectReadModel>;

  /**
   * One transaction under the claim lock: reads the facts again, and deletes every operation of
   * the Project, with their log lines, only when `mayDelete` still agrees. `false` when it does
   * not, so an operation a controller claimed meanwhile is never deleted from under it.
   */
  deleteForDisconnect(
    projectId: string,
    mayDelete: (facts: PreviewDisconnectReadModel) => boolean,
  ): Promise<boolean>;

  /** The facts of the Project's Preview state; both `null` for a Project with no operation. */
  findPreviewFacts(projectId: string): Promise<PreviewReadModel>;

  /**
   * The Project's newest build (by request time) that the Run's merge started or that built
   * `commit`, or `null` when there is none.
   */
  findMergeBuild(
    projectId: string,
    runId: string,
    commit: string,
  ): Promise<PreviewOperation | null>;

  /** Whether the Project requested a build at or after `since`. */
  hasBuildSince(projectId: string, since: Date): Promise<boolean>;

  /** The operation, or `null` when none has this id (also an id that is not a UUID). */
  find(id: string): Promise<PreviewOperation | null>;

  /**
   * One transaction: loads the operation `FOR UPDATE`, calls `mutate`, saves what it changed.
   * `null` when none has this id. `mutate` does no I/O; what it throws rolls back and reaches the
   * caller. The row lock serializes the change with every other change of the operation.
   */
  change(
    id: string,
    mutate: (operation: PreviewOperation) => void,
  ): Promise<PreviewOperation | null>;

  /**
   * One statement: fails every claimed operation the rule selects with the rule's failure, and
   * releases its Environment file reference. Returns the secret references released, for the
   * caller to delete; a lost operation is never handed out again.
   */
  failLost(rule: LostControllerRule, now: Date): Promise<string[]>;

  /** As {@link failLost}, for the claimed builds the rule selects; returns the secret references released. */
  failOverdue(rule: OverdueBuildRule, now: Date): Promise<string[]>;

  /** One statement: fails every requested operation the rule selects. Returns how many. */
  failUnclaimed(rule: UnclaimedOperationRule, now: Date): Promise<number>;

  /**
   * One atomic statement under a claim lock (`PreviewOperationHandOutRule`), skipping rows another
   * claim holds. `null` when there is nothing to do; a partial unique index is the backstop.
   */
  claimNext(controllerId: string, now: Date): Promise<PreviewOperation | null>;

  /** The secret reference of the operation's Environment file snapshot, or `null` when it holds none. */
  findEnvironmentFileSecret(id: string): Promise<string | null>;

  /** Every Environment file snapshot reference an operation still holds. */
  listEnvironmentFileSecrets(): Promise<string[]>;
}
