import { PreviewOperationFailure } from './preview-operation-failure.js';

/** Fails a requested operation that nobody claimed for too long, the cut-off the statement uses. */
export class UnclaimedOperationRule {
  private constructor(
    readonly requestedBefore: Date,
    readonly failure: PreviewOperationFailure,
  ) {}

  static at(now: Date, minutes: number): UnclaimedOperationRule {
    return new UnclaimedOperationRule(
      new Date(now.getTime() - minutes * 60_000),
      PreviewOperationFailure.of(
        'not_claimed',
        `No environment controller took the operation within ${minutes} minutes.`,
      ),
    );
  }

  selects(operation: { status: string; requestedAt: Date }): boolean {
    return operation.status === 'requested' && operation.requestedAt < this.requestedBefore;
  }
}
