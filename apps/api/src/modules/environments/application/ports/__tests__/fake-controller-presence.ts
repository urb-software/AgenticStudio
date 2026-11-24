import { ControllerAvailability } from '../../../domain/value-objects/controller-availability.js';
import type { ControllerPresence } from '../controller-presence.js';

/** A presence a test sets directly. */
export class FakeControllerPresence implements ControllerPresence {
  seen: Date | null = null;
  readonly recorded: Date[] = [];

  constructor(private readonly started: Date) {}

  record(at: Date): void {
    this.recorded.push(at);
    this.seen = at;
  }

  availability(leaseSeconds: number): ControllerAvailability {
    return ControllerAvailability.of({
      lastSeenAt: this.seen,
      startedAt: this.started,
      leaseSeconds,
    });
  }
}
