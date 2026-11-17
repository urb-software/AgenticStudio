/** What a Run's worker claim stores of it. */
export interface RunWorkerClaimStored {
  /**
   * The agent worker holding it: set exactly when `preparing` or `running`, or while it retries
   * the delivery of a `failed` Run (Issue #102).
   */
  claimedBy: string | null;
  /**
   * The agent worker that last claimed the Run to start or resume it (Issue #102): only it holds
   * the Working copy and the agent's session. Internal, never in the operator API.
   */
  lastClaimedBy: string | null;
  /**
   * The agent worker that released the Run (to `waiting_for_operator` or a final state), so a
   * retried report of that same change is recognised (review of #121).
   */
  releasedBy: string | null;
  /**
   * When the worker holding the Run last reported (Issue #96): set exactly while `claimedBy` is.
   * A held Run whose heartbeat is older than the lease has lost its worker (`LostWorkerRule`).
   */
  heartbeatAt: Date | null;
  /**
   * The agent session the last Run step reported (Issue #103): an answer resumes it. Internal:
   * it goes to the agent worker that holds the Working copy, never to the operator API.
   */
  sessionRef: string | null;
  /** When the agent worker reported its retention removed the Working copy (Issue #141). */
  workingCopyRemovedAt: Date | null;
  /**
   * Whether the Run was given its Project's Environment file when it was claimed (Issue #104):
   * a snapshot taken then; later changes to the file affect only later Runs. Never the content.
   */
  environmentFileSupplied: boolean;
  /**
   * That file's path in the Working copy, set exactly when supplied: never committed or pushed
   * by a delivery, a retry too (Issue #102's `studioPaths`). Not secret, not in the operator API.
   */
  environmentFilePath: string | null;
}

/**
 * The claim an agent worker has on a Run: the worker holding it now, the worker that held it
 * last (only it has the Working copy and the agent session), the one that released it, its last
 * heartbeat, the agent session, and what the claim handed it (the Environment file's path) or it
 * reported back (that retention removed the Working copy). A change returns a new claim.
 */
export class RunWorkerClaim {
  readonly claimedBy: string | null;
  readonly lastClaimedBy: string | null;
  readonly releasedBy: string | null;
  readonly heartbeatAt: Date | null;
  readonly sessionRef: string | null;
  readonly workingCopyRemovedAt: Date | null;
  readonly environmentFileSupplied: boolean;
  readonly environmentFilePath: string | null;

  private constructor(stored: RunWorkerClaimStored) {
    this.claimedBy = stored.claimedBy;
    this.lastClaimedBy = stored.lastClaimedBy;
    this.releasedBy = stored.releasedBy;
    this.heartbeatAt = stored.heartbeatAt;
    this.sessionRef = stored.sessionRef;
    this.workingCopyRemovedAt = stored.workingCopyRemovedAt;
    this.environmentFileSupplied = stored.environmentFileSupplied;
    this.environmentFilePath = stored.environmentFilePath;
  }

  /** The claim of a Run just started: no worker has it. */
  static none(): RunWorkerClaim {
    return new RunWorkerClaim({
      claimedBy: null,
      lastClaimedBy: null,
      releasedBy: null,
      heartbeatAt: null,
      sessionRef: null,
      workingCopyRemovedAt: null,
      environmentFileSupplied: false,
      environmentFilePath: null,
    });
  }

  static restore(stored: RunWorkerClaimStored): RunWorkerClaim {
    return new RunWorkerClaim(stored);
  }

  /** The claim with the stored fields in `patch` replaced (other keys are ignored). */
  with(patch: Partial<RunWorkerClaimStored>): RunWorkerClaim {
    return new RunWorkerClaim({ ...this.toStored(), ...patch });
  }

  toStored(): RunWorkerClaimStored {
    return {
      claimedBy: this.claimedBy,
      lastClaimedBy: this.lastClaimedBy,
      releasedBy: this.releasedBy,
      heartbeatAt: this.heartbeatAt,
      sessionRef: this.sessionRef,
      workingCopyRemovedAt: this.workingCopyRemovedAt,
      environmentFileSupplied: this.environmentFileSupplied,
      environmentFilePath: this.environmentFilePath,
    };
  }

  /** Whether an agent worker holds the Run. */
  get isHeld(): boolean {
    return this.claimedBy !== null;
  }

  /** Whether `workerId` holds the Run. */
  isHeldBy(workerId: string): boolean {
    return this.claimedBy === workerId;
  }

  /** Whether `workerId` was the last to claim the Run to start or resume it. */
  wasLastClaimedBy(workerId: string): boolean {
    return this.lastClaimedBy === workerId;
  }

  /**
   * Whether `workerId` is the worker whose report the Run last took: it holds the Run, or it
   * released it, so a retried report of that same change is recognised (review of #121).
   */
  isReportedBy(workerId: string): boolean {
    return (this.claimedBy ?? this.releasedBy) === workerId;
  }

  /** Whether the Run has an agent session to resume. */
  get hasSession(): boolean {
    return this.sessionRef !== null;
  }

  /** Whether the worker reported its retention removed the Working copy. */
  get workingCopyRemoved(): boolean {
    return this.workingCopyRemovedAt !== null;
  }
}
