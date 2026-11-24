import { Injectable } from '@nestjs/common';
import type { ControllerPresence } from '../../application/ports/controller-presence.js';
import { ControllerAvailability } from '../../domain/value-objects/controller-availability.js';

/** Presence of one API instance, kept in memory. */
@Injectable()
export class InMemoryControllerPresence implements ControllerPresence {
  private seen: Date | null = null;

  constructor(private readonly started: Date = new Date()) {}

  record(at: Date): void {
    if (this.seen === null || at > this.seen) this.seen = at;
  }

  availability(leaseSeconds: number): ControllerAvailability {
    return ControllerAvailability.of({
      lastSeenAt: this.seen,
      startedAt: this.started,
      leaseSeconds,
    });
  }
}
