import { PreviewOperationFailure } from './preview-operation-failure.js';
import type { PreviewOperationQueueView } from './preview-operation-queue-view.js';

/**
 * The claim statement first fails every stale claimed operation with the cut-off and the failure
 * this rule supplies; `selects` is the same selection over one operation, which a test uses to
 * prove the statement follows it. A lost operation is never handed out again.
 */
export class LostControllerRule {
  private constructor(
    readonly staleBefore: Date,
    readonly failure: PreviewOperationFailure,
  ) {}

  static at(now: Date, leaseSeconds: number): LostControllerRule {
    return new LostControllerRule(
      new Date(now.getTime() - leaseSeconds * 1000),
      PreviewOperationFailure.of(
        'controller_lost',
        `The environment controller sent no report for ${leaseSeconds} seconds.`,
      ),
    );
  }

  selects(operation: Pick<PreviewOperationQueueView, 'status' | 'heartbeatAt'>): boolean {
    return (
      operation.status === 'claimed' &&
      operation.heartbeatAt !== null &&
      operation.heartbeatAt < this.staleBefore
    );
  }
}
