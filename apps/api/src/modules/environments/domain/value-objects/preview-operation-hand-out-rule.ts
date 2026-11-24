import { LostControllerRule } from './lost-controller-rule.js';
import type { PreviewOperationQueueView } from './preview-operation-queue-view.js';

/**
 * The store hands operations out in one atomic statement that skips rows another claim holds;
 * `next` is the same rule in memory, which a test uses to prove the statement follows it. The
 * oldest `requested` operation goes first, and only of a Project with no claimed operation.
 */
export class PreviewOperationHandOutRule {
  private constructor(readonly lost: LostControllerRule) {}

  static at(now: Date, leaseSeconds: number): PreviewOperationHandOutRule {
    return new PreviewOperationHandOutRule(LostControllerRule.at(now, leaseSeconds));
  }

  /** Stale claims are lost first, so they no longer hold their Project. */
  next<T extends PreviewOperationQueueView>(operations: readonly T[]): T | undefined {
    const holding = new Set(
      operations
        .filter((operation) => operation.status === 'claimed' && !this.lost.selects(operation))
        .map((operation) => operation.projectId),
    );
    return operations
      .filter((operation) => operation.status === 'requested' && !holding.has(operation.projectId))
      .sort(
        (a, b) =>
          a.requestedAt.getTime() - b.requestedAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )[0];
  }
}
