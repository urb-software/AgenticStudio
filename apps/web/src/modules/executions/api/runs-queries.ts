'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type RunOutput,
  type RunStepListOutput,
  type StartRunRequest,
} from '../../../platform/api';

/** States in which a Run is polled often: it moves on without the operator. */
const MOVING: readonly RunOutput['state'][] = ['queued', 'preparing', 'running'];

/** How often a moving Run is read again while the page is visible. */
const ACTIVE_POLL_MS = 2_000;
/** How often a Run waiting for the operator is read again: it only moves when they act. */
const WAITING_POLL_MS = 10_000;

/**
 * The poll interval for a set of Runs (#97 DoR): fast while any is queued, preparing or
 * running (or retrying its delivery), slower while one only waits for the operator, and none once all are finished.
 */
function pollIntervalFor(runs: readonly RunOutput[] | undefined): number | false {
  if (!runs) return false;
  // A requested delivery retry (Issue #102) moves on without the operator too.
  if (runs.some((run) => MOVING.includes(run.state) || run.deliveryRetryRequested)) {
    return ACTIVE_POLL_MS;
  }
  if (runs.some((run) => run.state === 'waiting_for_operator')) return WAITING_POLL_MS;
  return false;
}

/** Every cache entry of this module starts with this key, so a start can refresh them all. */
const RUNS_KEY = ['runs'] as const;

/** One project's Runs, newest first. */
const projectRunsKey = (projectId: string) => ['runs', 'project', projectId] as const;

/** Every Run across all projects, newest first. */
const ALL_RUNS_KEY = ['runs', 'all'] as const;

/** The project list, for the project names on the Executions page. */
const PROJECTS_KEY = ['runs', 'projects'] as const;

/** Provider availability for one opening of the New run dialog. */
const providersKey = (opening: number) => ['runs', 'providers', opening] as const;

/** One Run. */
const runKey = (runId: string) => ['runs', 'run', runId] as const;

/** The project of a Run, for its name on the Run page. */
const runProjectKey = (projectId: string) => ['runs', 'project-detail', projectId] as const;

/**
 * The project's Runs, from the server only (frontend.md §4). Polled while any of them is
 * active, and only while the tab is visible (TanStack Query pauses intervals in a hidden tab
 * and refetches on focus).
 */
export function useProjectRuns(projectId: string, enabled = true) {
  return useQuery({
    queryKey: projectRunsKey(projectId),
    queryFn: () => api.listProjectRuns(projectId),
    enabled,
    refetchInterval: (query) => pollIntervalFor(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/**
 * Every Run across all projects, from the server only. Polled like a project's Runs: while any
 * is active and the tab is visible. The Executions page and the top-bar run indicator share it.
 */
export function useAllRuns() {
  return useQuery({
    queryKey: ALL_RUNS_KEY,
    queryFn: api.listRuns,
    refetchInterval: (query) => pollIntervalFor(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/**
 * The projects, by id, for their names next to Runs. Its own cache entry for the same reason as
 * {@link useRunProject}: the projects module's queries are private to it.
 */
export function useProjectNames() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: api.listProjects,
    select: (list) => new Map(list.items.map((project) => [project.id, project.name])),
  });
}

/** One Run; polled while it is active and the tab is visible, never once it is finished. */
export function useRun(runId: string) {
  return useQuery({
    queryKey: runKey(runId),
    queryFn: () => api.getRun(runId),
    refetchInterval: (query) => pollIntervalFor(query.state.data && [query.state.data]),
    refetchIntervalInBackground: false,
  });
}

/**
 * The Run's project (its name and link on the Run page). A cache entry of its own on purpose:
 * the projects module's query is private to it, and importing that module from here would make
 * a cycle (projects composes this module's Runs section).
 */
export function useRunProject(projectId: string | undefined) {
  return useQuery({
    queryKey: runProjectKey(projectId ?? ''),
    queryFn: () => api.getProject(projectId!),
    enabled: projectId !== undefined,
  });
}

/**
 * Which providers can take a Run now (Issue #101), for one opening of the New run dialog. Each
 * opening has its own cache entry (`opening` counts them), so it starts with no answer (pending)
 * and never shows an earlier opening's; finished entries are dropped (`gcTime: 0`). The server's
 * start check and the agent worker's own check stay authoritative.
 */
export function useProviderAvailability(opening: number, enabled: boolean) {
  return useQuery({
    queryKey: providersKey(opening),
    queryFn: api.listProviders,
    enabled,
    staleTime: Infinity,
    gcTime: 0,
  });
}

/**
 * "Retry delivery" (Issue #102): asks the agent worker to repeat only the delivery of a Run
 * whose delivery failed. The 202 answer (the Run, retry requested) replaces the cached Run, so
 * the page polls it until the worker reports the outcome; every Run list is read again.
 */
export function useRetryDelivery(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryRunDelivery(runId),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
}

/**
 * "Resume run" (Issue #105): resumes a Run stopped at the subscription's usage limit. The 202
 * answer (the Run, queued) replaces the cached Run, so the page follows it; every Run list is
 * read again.
 */
export function useResumeRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeRun(runId),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
}

/**
 * Starts a Run. The 201 answer seeds the Run's own query (its page shows it at once), and
 * every Run list of this module is read again.
 */
export function useStartRun(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: StartRunRequest) => api.startRun(projectId, request),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
  });
}

/**
 * Cancels a Run (Issue #100). The 202 answer replaces the Run's own query (cancelled at once,
 * or with its cancel request), and every Run list of this module is read again.
 */
export function useCancelRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    // A refusal (e.g. the Run finished meanwhile) also means the page's Run is out of date.
    onError: () => queryClient.invalidateQueries({ queryKey: runKey(runId) }),
  });
}

/** The structured results of a Run's steps, shown at each step's end in its log (Issue #99). */
const runStepsKey = (runId: string) => ['runs', 'steps', runId] as const;

/** Step results by step number; stable per response, so derived rows are not rebuilt. */
const stepsByIndex = (list: RunStepListOutput) =>
  new Map(list.steps.map((step) => [step.index, step]));

export function useRunSteps(runId: string) {
  return useQuery({
    queryKey: runStepsKey(runId),
    queryFn: () => api.listRunSteps(runId),
    select: stepsByIndex,
  });
}

/** Reads the step results again, e.g. when the live log shows a step has finished. */
export function useRefreshRunSteps(runId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: runStepsKey(runId) });
}
