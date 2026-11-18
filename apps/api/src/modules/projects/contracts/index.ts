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
