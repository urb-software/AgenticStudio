export interface RunWorkerClaimStored {
  /** Set exactly when `preparing` or `running`, or while it retries the delivery of a `failed` Run. */
  claimedBy: string | null;
  /** Only it holds the Working copy and the agent's session. Internal, never in the operator API. */
  lastClaimedBy: string | null;
  /** So a retried report of that same change is recognised. */
  releasedBy: string | null;
  /** Set exactly while `claimedBy` is; a held Run whose heartbeat is older than the lease has lost its worker. */
  heartbeatAt: Date | null;
  /** Internal: it goes to the agent worker that holds the Working copy, never to the operator API. */
  sessionRef: string | null;
  workingCopyRemovedAt: Date | null;
  /** A snapshot taken at the claim; later changes to the file affect only later Runs. Never the content. */
  environmentFileSupplied: boolean;
  /** Never committed or pushed by a delivery, a retry too. Not secret, not in the operator API. */
  environmentFilePath: string | null;
}

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

  get isHeld(): boolean {
    return this.claimedBy !== null;
  }

  isHeldBy(workerId: string): boolean {
    return this.claimedBy === workerId;
  }

  wasLastClaimedBy(workerId: string): boolean {
    return this.lastClaimedBy === workerId;
  }

  isReportedBy(workerId: string): boolean {
    return (this.claimedBy ?? this.releasedBy) === workerId;
  }

  get hasSession(): boolean {
    return this.sessionRef !== null;
  }

  get workingCopyRemoved(): boolean {
    return this.workingCopyRemovedAt !== null;
  }
}
