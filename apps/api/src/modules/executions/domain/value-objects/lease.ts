/** How long after its last report a worker still counts as connected. */
export class Lease {
  private constructor(readonly seconds: number) {}

  static ofSeconds(seconds: number): Lease {
    return new Lease(seconds);
  }

  /** False when it was never seen. */
  covers(seenAt: Date | undefined, now: Date): boolean {
    return seenAt !== undefined && now.getTime() - seenAt.getTime() <= this.seconds * 1000;
  }
}
