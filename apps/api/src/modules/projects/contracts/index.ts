import type { EnvironmentFile } from '@agentic-studio/contracts';

export const RUN_START_POINTS = Symbol('RUN_START_POINTS');

/**
 * Where a Run of a project would start: the integration branch's current commit when the
 * Repository is `ready`, its remote URL (never a credential) and branch, otherwise why not.
 */
export type RunStartPoint =
  | { status: 'ready'; startCommit: string; remoteUrl: string; integrationBranch: string }
  | { status: 'project_not_found' }
  | { status: 'no_repository' }
  | { status: 'repository_not_ready' };

export interface RunStartPoints {
  /** The start point of a Run of this project; an id that is not a UUID names no project. */
  forProject(projectId: string): Promise<RunStartPoint>;
}

export const RUN_ENVIRONMENT_FILES = Symbol('RUN_ENVIRONMENT_FILES');

/**
 * A project's Environment file for the agent worker that claims a Run: path and content (a
 * secret), never for an operator response or a log. The shape is the worker protocol's.
 */
export interface RunEnvironmentFiles {
  /** The project's current Environment file, or `null` when none is set. */
  forProject(projectId: string): Promise<EnvironmentFile | null>;
}

export const RUN_BRANCH_REVIEWS = Symbol('RUN_BRANCH_REVIEWS');

/**
 * Why a review could not fetch: `repository_not_ready` (no Repository, or not `ready`),
 * `branch_not_found` (the Run branch is gone from the Git host), `unsupported_platform`
 * (the API does not run on Linux), `failed` (anything else, with a redacted `detail`).
 */
export type RunBranchFetchResult =
  | { status: 'ready'; runCommit: string; integrationCommit: string }
  | {
      status: 'repository_not_ready' | 'branch_not_found' | 'unsupported_platform' | 'failed';
      detail?: string;
    };

export interface MergeDiffLimits {
  filesMax: number;
  filePatchMaxBytes: number;
  patchMaxBytes: number;
}

export interface MergeDiffFile {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  binary?: true;
  /** Absent for a binary file and for one a limit left out (`cut`). */
  patch?: string;
  cut: boolean;
}

export type MergeDiffResult =
  | { status: 'computed'; files: MergeDiffFile[]; truncated: boolean }
  | { status: 'conflicting' }
  | { status: 'repository_not_ready' | 'unsupported_platform' | 'failed'; detail?: string };

/**
 * What the Integration branch would gain from a Run's branch, computed on Studio's side from
 * the Project's Clone with the Project's own credentials (a Deploy key, or none for HTTPS).
 */
export interface RunBranchReviews {
  /** Whether reviews can run on this host (Linux only). */
  supported(): boolean;

  /**
   * Fetches the Integration branch and the Run's own `agent/…-r<run id>` branch in one fetch.
   * The Run branch is never checked out. A `runBranch` that is not the Run's own is `failed`.
   */
  fetchForReview(
    projectId: string,
    runId: string,
    runBranch: string,
  ): Promise<RunBranchFetchResult>;

  /** The merge result's changes against `integrationCommit`, under `limits`; ends the Run's review refs. */
  mergeDiff(
    projectId: string,
    runId: string,
    runCommit: string,
    integrationCommit: string,
    limits: MergeDiffLimits,
  ): Promise<MergeDiffResult>;
}
