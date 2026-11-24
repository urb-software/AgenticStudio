/**
 * Selects the Projects whose newest operation is a claimed build the API failed because the
 * controller went silent; a `state` operation then asks what runs, and being the newest it ends
 * the selection. The store's statement follows it, which a test proves.
 */
export class StateCheckRule {
  /** The failures after which a build may have left the Preview different from what the API shows. */
  static readonly UNCERTAIN_FAILURES: readonly string[] = ['controller_lost', 'report_overdue'];

  private constructor() {}

  static create(): StateCheckRule {
    return new StateCheckRule();
  }

  /** `operation` is the newest operation of its Project. */
  selects(operation: {
    kind: string;
    status: string;
    claimedAt: Date | null;
    failureCode: string | null;
  }): boolean {
    return (
      operation.kind === 'build' &&
      operation.status === 'failed' &&
      operation.claimedAt !== null &&
      operation.failureCode !== null &&
      StateCheckRule.UNCERTAIN_FAILURES.includes(operation.failureCode)
    );
  }
}
