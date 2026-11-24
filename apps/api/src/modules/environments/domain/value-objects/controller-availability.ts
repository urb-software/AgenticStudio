export interface ControllerAvailabilityFacts {
  /** When any controller call last reached this API instance, or `null` when none has. */
  lastSeenAt: Date | null;
  /** When this API instance started. */
  startedAt: Date;
  leaseSeconds: number;
}

/** Whether an environment controller is there, judged from the calls this API instance has seen. */
export class ControllerAvailability {
  private constructor(private readonly facts: ControllerAvailabilityFacts) {}

  static of(facts: ControllerAvailabilityFacts): ControllerAvailability {
    return new ControllerAvailability(facts);
  }

  /** A controller called within one lease. */
  connected(now: Date): boolean {
    const { lastSeenAt, leaseSeconds } = this.facts;
    return lastSeenAt !== null && now.getTime() - lastSeenAt.getTime() <= leaseSeconds * 1000;
  }

  /**
   * Not connected, and this instance has run for a lease or longer, so a controller that exists
   * has had time to call; right after a start nothing is known.
   */
  knownAbsent(now: Date): boolean {
    const { startedAt, leaseSeconds } = this.facts;
    return !this.connected(now) && now.getTime() - startedAt.getTime() >= leaseSeconds * 1000;
  }
}
