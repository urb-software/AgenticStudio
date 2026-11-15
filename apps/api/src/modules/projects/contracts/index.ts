/**
 * Public entry point of the `projects` module for other modules (backend.md §3). Nothing here
 * imports the module's internals; the module binds {@link RUN_START_POINTS} to its own
 * implementation and exports it through its Nest module.
 */

/** DI token of {@link RunStartPoints}. */
export const RUN_START_POINTS = Symbol('RUN_START_POINTS');

/**
 * Where a Run of a project would start (Issue #96): the current commit of the integration
 * branch when the project's Repository is `ready`, and the Repository's remote URL as the
 * operator connected it (Issue #98; never a credential), otherwise why there is none.
 */
export type RunStartPoint =
  | { status: 'ready'; startCommit: string; remoteUrl: string }
  | { status: 'project_not_found' }
  | { status: 'no_repository' }
  | { status: 'repository_not_ready' };

/** What `projects` tells other modules about starting a Run (Issue #96). */
export interface RunStartPoints {
  /** The start point of a Run of this project; an id that is not a UUID names no project. */
  forProject(projectId: string): Promise<RunStartPoint>;
}

/** DI token of {@link RunEnvironmentFiles}. */
export const RUN_ENVIRONMENT_FILES = Symbol('RUN_ENVIRONMENT_FILES');

/**
 * A project's Environment file with its content (Issue #104): a secret value (test values
 * only), for the agent worker that claimed a Run, never for an operator response or a log.
 */
export interface RunEnvironmentFile {
  /** Relative POSIX path in the repository. */
  path: string;
  content: string;
}

/** What `projects` tells `executions` about a project's Environment file (Issue #104). */
export interface RunEnvironmentFiles {
  /** The project's current Environment file, or `null` when none is set. */
  forProject(projectId: string): Promise<RunEnvironmentFile | null>;
}
