/**
 * The limits of a Run (Issue #100), from the API's configuration, copied onto the Run when it
 * is started: the longest a Run step may work, the most Run steps the Run may take, and the
 * longest it may wait for the operator before it is cancelled.
 */
export interface RunLimits {
  stepMinutes: number;
  /** The most Run steps the first part of the Run, and each Follow-up, may take (Issue #141). */
  maxSteps: number;
  waitingDays: number;
  /** The most Run steps the Run may take in total before it accepts no Follow-up (Issue #141). */
  maxTotalSteps: number;
}
