/**
 * How old an unreferenced Deploy key must be before the sweep deletes it (Issue #76): far
 * longer than a Connect takes between storing a new key and saving the Repository that
 * references it, so the sweep never races a Connect in flight.
 */
export const DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS = 60 * 60 * 1000;

/**
 * Which stored Deploy keys are orphaned (Issue #76). A key is orphaned when it is older than
 * the grace period and no Repository references it, in any state. Age is judged by the secret
 * store's own clock, which only the store can read: the port lists the keys already older
 * than {@link gracePeriodMs}, and this rule takes that list and the referenced keys as values.
 */
export class DeployKeySweepPolicy {
  private constructor(readonly gracePeriodMs: number) {}

  static of(gracePeriodMs: number = DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS): DeployKeySweepPolicy {
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) {
      throw new RangeError('The Deploy key grace period must be a non-negative integer.');
    }
    return new DeployKeySweepPolicy(gracePeriodMs);
  }

  /** The stored keys older than the grace period that no Repository references. */
  orphans(storedOlderThanGracePeriod: readonly string[], referenced: Iterable<string>): string[] {
    const kept = new Set(referenced);
    return storedOlderThanGracePeriod.filter((secretRef) => !kept.has(secretRef));
  }
}
