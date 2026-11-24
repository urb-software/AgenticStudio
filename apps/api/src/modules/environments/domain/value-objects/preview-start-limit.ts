import type { PreviewStateName } from './preview-state.js';

/** One Project whose Preview takes a place. */
export interface PreviewStartLimitOccupant {
  readonly projectId: string;
  readonly state: PreviewStateName;
}

export interface PreviewStartLimitFacts {
  readonly projectId: string;
  readonly occupying: readonly PreviewStartLimitOccupant[];
}

/** At most this many Previews run at the same time; a rebuild of a running Preview keeps its place. */
export class PreviewStartLimit {
  static readonly BOUNDS = { min: 1, max: 50 } as const;

  private constructor(readonly max: number) {}

  static of(max: number): PreviewStartLimit {
    if (!Number.isInteger(max) || max < PreviewStartLimit.BOUNDS.min) {
      throw new RangeError('The running Previews limit must be a positive integer.');
    }
    return new PreviewStartLimit(max);
  }

  /** The Previews that hold the places when the Project may not start, or `null` when it may. */
  refusal(facts: PreviewStartLimitFacts): readonly PreviewStartLimitOccupant[] | null {
    const { projectId, occupying } = facts;
    if (occupying.some((preview) => preview.projectId === projectId)) return null;
    return occupying.length >= this.max ? occupying : null;
  }
}
