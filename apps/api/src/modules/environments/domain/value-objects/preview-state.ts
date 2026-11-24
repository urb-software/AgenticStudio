import {
  PreviewBuildRunningError,
  PreviewBusyError,
  PreviewNotRunningError,
} from '../errors/preview-settings-errors.js';

export type PreviewStateName =
  'not_configured' | 'stopped' | 'stopping' | 'resetting_data' | 'building' | 'running' | 'failed';

/** Why a request to build, stop or reset is not accepted now: the error to throw. */
export type PreviewStateRefusal =
  PreviewBusyError | PreviewBuildRunningError | PreviewNotRunningError;

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
  /** The newest stop or data removal by request time. */
  latestChange: PreviewStateOperation | null;
}

/** What the Project's Preview is, derived from its operations; nothing about it is stored. */
export class PreviewState {
  private constructor(
    readonly name: PreviewStateName,
    /** The build Studio last asked to run, or `null` when nothing is meant to run. */
    readonly running: { buildId: string; commit: string; since: Date } | null,
    /** A build is requested or claimed. */
    readonly buildActive: boolean,
    /** A stop or a data removal is requested or claimed. */
    readonly changeActive: boolean,
  ) {}

  /** Precedence: resetting data, stopping, building, running, not configured, failed, stopped. */
  static of(facts: PreviewStateFacts): PreviewState {
    const { configured, latestBuild, runningChange, latestChange } = facts;
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
    const changeActive =
      latestChange !== null &&
      (latestChange.status === 'requested' || latestChange.status === 'claimed');
    const make = (name: PreviewStateName, runs: typeof running) =>
      new PreviewState(name, runs, buildActive, changeActive);
    if (changeActive && latestChange.kind === 'remove_data') return make('resetting_data', running);
    if (changeActive) return make('stopping', running);
    if (buildActive) return make('building', running);
    if (running !== null) return make('running', running);
    if (!configured) return make('not_configured', null);
    if (latestBuild !== null && latestBuild.status === 'failed') return make('failed', null);
    return make('stopped', null);
  }

  /** A build is refused while a stop or reset or another build is active; `null` when accepted. */
  buildRefusal(): PreviewStateRefusal | null {
    if (this.changeActive) return new PreviewBusyError();
    return this.buildActive ? new PreviewBuildRunningError() : null;
  }

  /** Stop is accepted only for a Preview that runs and nothing else is changing. */
  stopRefusal(): PreviewStateRefusal | null {
    if (this.changeActive) return new PreviewBusyError();
    if (this.buildActive) return new PreviewBuildRunningError();
    return this.name === 'running' ? null : new PreviewNotRunningError();
  }

  /** Reset is accepted in every state but while a build or a change is active. */
  resetRefusal(): PreviewStateRefusal | null {
    return this.buildRefusal();
  }
}
