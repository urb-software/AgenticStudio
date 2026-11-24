export type PreviewStateName = 'not_configured' | 'stopped' | 'building' | 'running' | 'failed';

/** The part of an operation the state is derived from. */
export interface PreviewStateOperation {
  id: string;
  kind: string;
  status: string;
  finishedAt: Date | null;
  build: { commit: string } | null;
}

export interface PreviewStateFacts {
  configured: boolean;
  /** The newest build by request time. */
  latestBuild: PreviewStateOperation | null;
  /** The newest finished operation that changes what runs. */
  runningChange: PreviewStateOperation | null;
}

/** What the Project's Preview is, derived from its operations; nothing about it is stored. */
export class PreviewState {
  private constructor(
    readonly name: PreviewStateName,
    /** The build Studio last asked to run, or `null` when nothing is meant to run. */
    readonly running: { buildId: string; commit: string; since: Date } | null,
    /** A build is requested or claimed. */
    readonly buildActive: boolean,
  ) {}

  /**
   * Precedence: building, running, not configured, failed, stopped. A failed build beside an
   * earlier one that still runs leaves the Preview running.
   */
  static of(facts: PreviewStateFacts): PreviewState {
    const { configured, latestBuild, runningChange } = facts;
    const running =
      runningChange !== null &&
      runningChange.kind === 'build' &&
      runningChange.status === 'succeeded' &&
      runningChange.build !== null &&
      runningChange.finishedAt !== null
        ? {
            buildId: runningChange.id,
            commit: runningChange.build.commit,
            since: runningChange.finishedAt,
          }
        : null;
    const buildActive =
      latestBuild !== null &&
      (latestBuild.status === 'requested' || latestBuild.status === 'claimed');
    if (buildActive) return new PreviewState('building', running, true);
    if (running !== null) return new PreviewState('running', running, false);
    if (!configured) return new PreviewState('not_configured', null, false);
    if (latestBuild !== null && latestBuild.status === 'failed') {
      return new PreviewState('failed', null, false);
    }
    return new PreviewState('stopped', null, false);
  }
}
