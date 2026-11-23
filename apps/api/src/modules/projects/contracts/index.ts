import type { EnvironmentFile, MergeMethod } from '@agentic-studio/contracts';

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

export const RUN_INTEGRATION_FETCHES = Symbol('RUN_INTEGRATION_FETCHES');

/**
 * `started`: the Repository fetches the Integration branch into the Clone (its record, not this
 * answer, tells how that ended). `not_started`: no fetch could be scheduled.
 */
export type IntegrationFetchResult = { status: 'started' } | { status: 'not_started' };

export interface RunIntegrationFetches {
  /** Never throws for a project that cannot fetch (unknown, no Repository, busy, not Linux). */
  fetchIntegrationBranch(projectId: string): Promise<IntegrationFetchResult>;
}

export const RUN_MERGE_METHODS = Symbol('RUN_MERGE_METHODS');

/** How a Project's Runs are merged: the setting `executions` reads when an operator approves a merge. */
export interface RunMergeMethods {
  /** The Project's current merge method. Throws when the project does not exist. */
  mergeMethodFor(projectId: string): Promise<MergeMethod>;
}

export const RUN_PREVIEW_SOURCES = Symbol('RUN_PREVIEW_SOURCES');

/** Longest file `readIntegrationFile` returns, in bytes: the Compose validation's own limit. */
export const INTEGRATION_FILE_MAX_BYTES = 256 * 1024;

/**
 * Whether a Project's Repository can be read for a Preview: `ready`, or why not
 * (`unsupported_platform`: the API does not run on Linux).
 */
export type PreviewSourceStatus =
  | { status: 'ready' }
  | {
      status:
        'project_not_found' | 'no_repository' | 'repository_not_ready' | 'unsupported_platform';
    };

/**
 * `found`: the regular file's text and the commit it was read at. `missing`: the path is not in
 * the tree, or is no regular file (a symlink, a submodule or a directory). `too_large`: the file
 * is over {@link INTEGRATION_FILE_MAX_BYTES}.
 */
export type IntegrationFileResult =
  | { status: 'found'; text: string; commit: string }
  | {
      status:
        | 'missing'
        | 'too_large'
        | 'project_not_found'
        | 'repository_not_ready'
        | 'unsupported_platform'
        | 'failed';
    };

/** What `environments` reads of a Project's Repository to set up a Preview. */
export interface RunPreviewSources {
  status(projectId: string): Promise<PreviewSourceStatus>;

  /**
   * One file of the Integration branch at the commit the Clone holds, read from Git's object
   * store and never from a working tree. The path must be a safe relative POSIX path.
   */
  readIntegrationFile(projectId: string, path: string): Promise<IntegrationFileResult>;
}
