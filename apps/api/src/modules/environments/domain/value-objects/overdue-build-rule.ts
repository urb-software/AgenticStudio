import { PreviewOperationFailure } from './preview-operation-failure.js';

/**
 * A claimed build still unreported this long after its time limit is failed, even when its
 * heartbeat keeps the lease alive. `selects` is the same selection over one operation as the
 * statement makes, which a test uses to prove the statement follows it.
 */
export class OverdueBuildRule {
  /** Minutes added to a build's own time limit before it counts as overdue. */
  static readonly MARGIN_MINUTES = 5;

  private constructor(
    readonly now: Date,
    readonly failure: PreviewOperationFailure,
  ) {}

  static at(now: Date): OverdueBuildRule {
    return new OverdueBuildRule(
      now,
      PreviewOperationFailure.of(
        'report_overdue',
        'The build did not report an end within its time limit plus a margin.',
      ),
    );
  }

  selects(operation: {
    status: string;
    kind: string;
    claimedAt: Date | null;
    buildMinutes: number | null;
  }): boolean {
    if (
      operation.status !== 'claimed' ||
      operation.kind !== 'build' ||
      operation.claimedAt === null ||
      operation.buildMinutes === null
    ) {
      return false;
    }
    const limit = (operation.buildMinutes + OverdueBuildRule.MARGIN_MINUTES) * 60_000;
    return operation.claimedAt.getTime() + limit < this.now.getTime();
  }
}
