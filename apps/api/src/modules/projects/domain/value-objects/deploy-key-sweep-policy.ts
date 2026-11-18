/**
 * How old an unreferenced Deploy key must be before the sweep deletes it: far longer than a Connect
 * takes between storing a key and saving the Repository, so the sweep never races a Connect.
 */
export const DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS = 60 * 60 * 1000;

/**
 * Which stored Deploy keys are orphaned: older than the grace period and referenced by no
 * Repository. Only the secret store's clock gives age, so the port lists keys older than
 * {@link gracePeriodMs} and this rule takes that list and the referenced keys.
 */
export class DeployKeySweepPolicy {
  private constructor(readonly gracePeriodMs: number) {}

  static of(gracePeriodMs: number = DEPLOY_KEY_SWEEP_GRACE_PERIOD_MS): DeployKeySweepPolicy {
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) {
      throw new RangeError('The Deploy key grace period must be a non-negative integer.');
    }
    return new DeployKeySweepPolicy(gracePeriodMs);
  }

  orphans(storedOlderThanGracePeriod: readonly string[], referenced: Iterable<string>): string[] {
    const kept = new Set(referenced);
    return storedOlderThanGracePeriod.filter((secretRef) => !kept.has(secretRef));
  }
}
