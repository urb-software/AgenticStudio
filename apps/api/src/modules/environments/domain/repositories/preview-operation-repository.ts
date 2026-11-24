import type { PreviewOperation } from '../entities/preview-operation.js';
import type { LostControllerRule } from '../value-objects/lost-controller-rule.js';

export const PREVIEW_OPERATION_REPOSITORY = Symbol('PREVIEW_OPERATION_REPOSITORY');

export interface PreviewOperationRepository {
  /** Stores a new operation; the caller checked that its Project exists. */
  add(operation: PreviewOperation): Promise<void>;

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
