import type { ControllerAvailability } from '../../domain/value-objects/controller-availability.js';

export const CONTROLLER_PRESENCE = Symbol('CONTROLLER_PRESENCE');

/** When an environment controller last called this API instance; lost on restart, by design. */
export interface ControllerPresence {
  /** Notes a controller call at `at`. */
  record(at: Date): void;

  /** What this instance has seen of the controller, judged against a lease of `leaseSeconds`. */
  availability(leaseSeconds: number): ControllerAvailability;
}
