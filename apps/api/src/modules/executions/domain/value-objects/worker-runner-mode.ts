/** How the agent worker runs a Run; the worker protocol's list is pinned to this one by a test. */
export const WORKER_RUNNER_MODES = ['fake', 'cli'] as const;
export type WorkerRunnerMode = (typeof WORKER_RUNNER_MODES)[number];
