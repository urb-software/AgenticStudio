import { PreviewOperationFailure } from './preview-operation-failure.js';

/**
 * A requested operation nobody claimed for this long is failed; it only applies while no
 * controller is known to exist. `selects` is the same selection over one operation as the
 * statement makes.
 */
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
