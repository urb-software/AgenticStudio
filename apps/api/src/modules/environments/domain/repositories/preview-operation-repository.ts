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
}

export interface PreviewOperationRepository {
  /**
   * Stores a new operation; the caller checked that its Project exists. Throws
   * `PreviewBuildRunningError` when the Project already has a requested or claimed build: a
   * unique index is the backstop of the caller's check.
   */
  add(operation: PreviewOperation): Promise<void>;

  /** The facts of the Project's Preview state; both `null` for a Project with no operation. */
  findPreviewFacts(projectId: string): Promise<PreviewReadModel>;

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
