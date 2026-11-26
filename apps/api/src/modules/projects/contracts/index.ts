import type { EnvironmentFile, MergeMethod } from '@agentic-studio/contracts';

export const PROJECT_KINDS = Symbol('PROJECT_KINDS');

/**
 * `code` for an ordinary Project; `definitions` for the Repository that holds agent definitions.
 */
export type ProjectKind = 'code' | 'definitions';

/** The states of a Repository connection, as `projects` reports them. */
export const REPOSITORY_STATES = [
  'awaiting_key',
  'awaiting_host_key',
  'connecting',
  'ready',
  'fetching',
  'failed',
  'disconnecting',
] as const;
export type RepositoryState = (typeof REPOSITORY_STATES)[number];

export interface ProjectKinds {
  /** The kind of the project with this id, or `null` when none has it (also for a non-UUID). */
  kindOf(projectId: string): Promise<ProjectKind | null>;

  /** The id of the definitions Project, or `null` when none exists. */
  definitionsProjectId(): Promise<string | null>;
}

export const DEFINITIONS_REPOSITORIES = Symbol('DEFINITIONS_REPOSITORIES');

/** The definitions Repository as `agents` reads it: no secret reference and no host key. */
export interface DefinitionsRepositoryState {
  projectId: string;
  /** `null` while the Project has no Repository connected yet. */
  repository: {
    state: RepositoryState;
    integrationBranch: string;
    /** The Integration branch's commit the Clone holds; `null` without a usable Clone. */
    headSha: string | null;
    lastFetchedAt: Date | null;
  } | null;
}

export interface DefinitionsRepositories {
  /** The definitions Project and its Repository, or `null` when none is connected. */
  current(): Promise<DefinitionsRepositoryState | null>;
}

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

export const PROJECT_DEFAULT_AGENTS = Symbol('PROJECT_DEFAULT_AGENTS');

/** The agent a Project names as its default, by name only; `project_not_found` for an unknown id. */
export type ProjectDefaultAgent =
  { status: 'found'; kind: ProjectKind; agent: string | null } | { status: 'project_not_found' };

export interface ProjectDefaultAgents {
  /** The Project's stored default agent as named, whether or not that agent is usable. */
  forProject(projectId: string): Promise<ProjectDefaultAgent>;
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
  /**
   * `commit` is the Integration branch's commit the Clone holds; `fetchedAt` is when the Clone
   * last finished a fetch, or `null` when it did not.
   */
  | { status: 'ready'; commit: string; fetchedAt: Date | null }
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

/**
 * `ready`: a tar archive of the commit's tracked tree, held in a temporary file until `close`
 * (call it in a `finally`; it may be called more than once). `commit_missing`: the Clone does not
 * hold the commit. `too_large`: the archive passed `maxBytes`. `failed`: anything else.
 */
export type PreviewArchiveResult =
  | {
      status: 'ready';
      sizeBytes: number;
      chunks: AsyncIterable<Uint8Array>;
      close(): Promise<void>;
    }
  | {
      status:
        'commit_missing' | 'too_large' | 'repository_not_ready' | 'unsupported_platform' | 'failed';
    };

/** What `environments` reads of a Project's Repository to set up a Preview. */
export interface RunPreviewSources {
  status(projectId: string): Promise<PreviewSourceStatus>;

  /**
   * One file of the Integration branch at the commit the Clone holds, read from Git's object
   * store and never from a working tree. The path must be a safe relative POSIX path.
   */
  readIntegrationFile(projectId: string, path: string): Promise<IntegrationFileResult>;

  /**
   * The tracked tree of `commit` as a tar archive of at most `maxBytes`, read from the Clone's
   * object store only. An id that names no project, or a Repository that is not `ready`, is
   * `repository_not_ready`.
   */
  openArchive(projectId: string, commit: string, maxBytes: number): Promise<PreviewArchiveResult>;

  /** The names of the projects with these ids; an unknown id has no entry. */
  projectNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export const REPOSITORY_DISCONNECT_STEPS = Symbol('REPOSITORY_DISCONNECT_STEPS');

/**
 * Something another module removes for a Project when its Repository is disconnected. `pending`
 * leaves the Repository `disconnecting` for the next retry, as a throw does; the step is
 * idempotent, so every retry runs it again until it answers `done`.
 */
export interface RepositoryDisconnectStep {
  readonly name: string;
  run(projectId: string): Promise<'done' | 'pending'>;
}

/** The list of steps other modules add theirs to at start-up; they run before the Clone is removed. */
export interface RepositoryDisconnectSteps {
  add(step: RepositoryDisconnectStep): void;
  list(): readonly RepositoryDisconnectStep[];
}

export const DEFINITIONS_FILES = Symbol('DEFINITIONS_FILES');

/** Most entries `listTree` returns; a larger tree is cut and reported as `truncated`. */
export const DEFINITIONS_TREE_MAX_ENTRIES = 20_000;

/** The definitions Repository as `agents` reads files from it: its state and the commit it holds. */
export interface DefinitionsSnapshot {
  state: RepositoryState;
  /** The Integration branch's commit the Clone holds; `null` without a usable Clone. */
  commit: string | null;
}

/**
 * One tracked item of the tree that was listed (below `agents/`, or anywhere); `size` is 0 for anything
 * that is not a regular file. `executable` is Git's mode `100755`.
 */
export interface DefinitionsTreeEntry {
  path: string;
  kind: 'file' | 'symlink' | 'submodule' | 'other';
  size: number;
  /** Absent means false. */
  executable?: boolean;
}

/**
 * Why a read could not happen: `repository_not_ready` (no definitions Repository, or its Clone is
 * gone), `unsupported_platform` (the API does not run on Linux), `commit_missing` (the Clone holds
 * no such commit), `failed` (anything else).
 */
export type DefinitionsUnavailable =
  'repository_not_ready' | 'unsupported_platform' | 'commit_missing' | 'failed';

export type DefinitionsTreeResult =
  | { status: 'listed'; entries: DefinitionsTreeEntry[]; truncated: boolean }
  | { status: DefinitionsUnavailable };

/**
 * `missing`: no regular file at the path. `too_large`: over the `maxBytes` of the read. `size` is
 * the file's size in bytes (0 for `missing`). `binary`: a NUL byte, or bytes that are not UTF-8
 * (the text then has replacement characters).
 */
export type DefinitionsFileRead =
  | { path: string; status: 'found'; text: string; size: number; binary: boolean }
  | { path: string; status: 'too_large'; size: number }
  | { path: string; status: 'missing'; size: 0 };

export type DefinitionsFilesResult =
  { status: 'read'; files: DefinitionsFileRead[] } | { status: DefinitionsUnavailable };

/** The stored bytes of a regular file; `missing` and `too_large` as for {@link DefinitionsFileRead}. */
export type DefinitionsBlobRead =
  | { path: string; status: 'found'; bytes: Uint8Array }
  | { path: string; status: 'missing' | 'too_large' };

/**
 * `blob` is Git's object name of the regular file at `path`, and `executable` its mode `100755`;
 * `null` and `false` when the path names none.
 */
export interface DefinitionsBlobId {
  path: string;
  blob: string | null;
  executable: boolean;
}

export type DefinitionsBlobIdsResult =
  { status: 'read'; blobs: DefinitionsBlobId[] } | { status: DefinitionsUnavailable };

export type DefinitionsBlobsResult =
  { status: 'read'; files: DefinitionsBlobRead[] } | { status: DefinitionsUnavailable };

/**
 * Reads the definitions Repository's Clone at a commit, from Git's object store only: no checkout
 * and no working-tree change. The caller judges what it reads.
 */
export interface DefinitionsFiles {
  /** The definitions Project's Repository state and last fetched commit, or `null` when none is connected. */
  snapshot(): Promise<DefinitionsSnapshot | null>;

  /**
   * Everything tracked under `agents/` at `commit`, under `skills/` with `directory`, or with
   * `whole` the whole tree, at most {@link DEFINITIONS_TREE_MAX_ENTRIES}.
   */
  listTree(
    commit: string,
    options?: { whole?: boolean; directory?: 'agents' | 'skills' },
  ): Promise<DefinitionsTreeResult>;

  /** The text of each regular file, in the order of `paths`; no file is read past `maxBytes`. */
  readFiles(
    commit: string,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<DefinitionsFilesResult>;

  /** The stored bytes of each regular file (no text decoding), in the order of `paths`. */
  readBlobs(
    commit: string,
    paths: readonly string[],
    maxBytes: number,
  ): Promise<DefinitionsBlobsResult>;

  /**
   * The object name of each regular file at `commit`, in the order of `paths`, without reading
   * any file: equal names mean equal content, so two commits are compared by them.
   */
  blobIds(commit: string, paths: readonly string[]): Promise<DefinitionsBlobIdsResult>;
}

export const DEFINITIONS_PUBLISH = Symbol('DEFINITIONS_PUBLISH');

/** One file of a publish: its new bytes, or `null` to delete it. `executable` is Git's mode `100755`. */
export interface DefinitionsPublishChange {
  path: string;
  content: Uint8Array | null;
  executable: boolean;
}

export interface DefinitionsPublishInput {
  /** The commit the changes were made against; it must be the commit the Clone holds. */
  baseCommit: string;
  changes: readonly DefinitionsPublishChange[];
  message: string;
  /** Author and committer: Studio's settings, never the request's. */
  identity: { name: string; email: string };
}

/**
 * `repository_moved`: the Clone or the remote is past the base. `write_refused`: the Git host
 * refused the write. `nothing_to_publish`: the tree would not change. `repository_not_ready`: no
 * usable definitions Clone. `failed`: anything else; no remote text is ever in the answer.
 */
export type DefinitionsPublishResult =
  | { status: 'published'; commit: string }
  | {
      status:
        | 'repository_moved'
        | 'write_refused'
        | 'nothing_to_publish'
        | 'repository_not_ready'
        | 'unsupported_platform'
        | 'failed';
    };

/**
 * Studio's one write to a Repository: a commit on the definitions Repository's Integration branch,
 * pushed as a fast-forward. It takes no Project: only the definitions Project is ever written, and
 * the Git adapter checks that again.
 */
export interface DefinitionsPublish {
  publish(input: DefinitionsPublishInput): Promise<DefinitionsPublishResult>;
}
