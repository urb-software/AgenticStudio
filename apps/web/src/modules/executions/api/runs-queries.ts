'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AnswerRunRequest,
  api,
  type BringUpToDateRequest,
  type FollowUpRunRequest,
  ApiError,
  type RefreshPullRequestRequest,
  type RunDiffOutput,
  type RunOutput,
  type RunsSummaryOutput,
  type RunStepListOutput,
  type StartRunRequest,
} from '../../../platform/api';
import { UNDER_WAY_STATES, WAITING_STATES } from '../components/run-states';

/** How often a moving Run is read again while the page is visible. */
const ACTIVE_POLL_MS = 2_000;
/** How often a Run waiting for the operator is read again: it only moves when they act. */
const WAITING_POLL_MS = 10_000;

/**
 * The poll interval for a set of Runs (#97 DoR): fast while any is active (or retrying its
 * delivery), slower while one only waits for the operator, and none once all are finished.
 */
function pollIntervalFor(
  runs: readonly RunOutput[] | undefined,
  /** Issue #142: also follow a pull request refresh under way (the Run page only). */
  followRefresh = false,
): number | false {
  if (!runs) return false;
  // A requested delivery retry (Issue #102) moves on without the operator too.
  // Issue #142: a pull request refresh an agent worker is carrying out moves on by itself too;
  // only the Run page follows it (a list cannot tell a refresh no worker will answer).
  if (
    runs.some(
      (run) =>
        UNDER_WAY_STATES.includes(run.state) ||
        run.deliveryRetryRequested ||
        (followRefresh && run.pullRequest?.refreshing),
    )
  ) {
    return ACTIVE_POLL_MS;
  }
  if (runs.some((run) => WAITING_STATES.includes(run.state))) return WAITING_POLL_MS;
  return false;
}

/** The same rule for the summary's counts (Issue #115). */
function summaryPollInterval(summary: RunsSummaryOutput | undefined): number | false {
  if (!summary) return false;
  if (summary.running > 0) return ACTIVE_POLL_MS;
  return summary.waiting > 0 ? WAITING_POLL_MS : false;
}

/** Every cache entry of this module starts with this key, so a start can refresh them all. */
const RUNS_KEY = ['runs'] as const;

/** One project's Runs, newest first. */
const projectRunsKey = (projectId: string) => ['runs', 'project', projectId] as const;

/** Every Run across all projects, newest first. */
const ALL_RUNS_KEY = ['runs', 'all'] as const;

/** How many Runs are active and waiting, across all projects. */
const RUNS_SUMMARY_KEY = ['runs', 'summary'] as const;

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
 * Every Run across all projects, from the server only, for the Executions page. Polled like a
 * project's Runs: while any is active and the tab is visible.
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
 * How many Runs are active and waiting for the operator (Issue #115), for the top-bar run
 * indicator on every page: two counts instead of every Run. Polled like the lists.
 */
export function useRunsSummary() {
  return useQuery({
    queryKey: RUNS_SUMMARY_KEY,
    queryFn: api.getRunsSummary,
    refetchInterval: (query) => summaryPollInterval(query.state.data),
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
    refetchInterval: (query) => pollIntervalFor(query.state.data && [query.state.data], true),
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
 * Answers the agent's question (Issue #103). The 202 answer (the Run, queued to resume)
 * replaces the cached Run, so the page polls it again; every Run list is read again. A 409
 * reads the Run again at once.
 */
export function useAnswerRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AnswerRunRequest) => api.answerRun(runId, request),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    // The Run moved on (answered elsewhere, cancelled): read it at once, not at the next poll
    // (review Spec-2 of #128).
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/**
 * Sends a Follow-up to a finished Run (Issue #141). The 202 answer (the Run, queued for the
 * Follow-up) replaces the cached Run, so the page polls it again; every Run list is read again.
 * A 409 (the Run cannot take one now) reads the Run again at once, so the page says why.
 */
export function useFollowUpRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FollowUpRunRequest) => api.followUpRun(runId, request),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/**
 * Asks for the Run's branch to be brought up to date (Issue #147): the Run, queued as a Follow-up
 * of that source, replaces the cached Run, so the page polls it again; every Run list is read
 * again. A 409 (the Run cannot take a Follow-up now) reads the Run again at once, so the page says
 * why.
 */
export function useBringUpToDateRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: BringUpToDateRequest) => api.bringUpToDateRun(runId, request),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/**
 * Asks for the state of the Run's pull request to be read again (Issue #142), when the Run page
 * opens (`onOpen`, which the API takes at most once a minute) or on "Refresh". The 202 answer (the
 * Run, marked as refreshing) replaces the cached Run, so the page polls it until an agent worker
 * has reported what it read.
 */
export function useRefreshPullRequest(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request?: RefreshPullRequestRequest) => api.refreshRunPullRequest(runId, request),
    onSuccess: (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
    },
  });
}

/**
 * "Resume run" (Issue #105): resumes a Run stopped at the subscription's usage limit. The 202
 * answer (the Run, queued) replaces the cached Run, so the page follows it; every Run list is
 * read again. A 409 (resumed elsewhere) reads the Run again at once.
 */
export function useResumeRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeRun(runId),
    onSuccess: async (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
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

/** A Run's diff of one scope (Issue #144), and one file of it. */
const runDiffKey = (runId: string, scope: RunDiffOutput['scope']) =>
  ['runs', 'diff', runId, scope] as const;
const runDiffFileKey = (runId: string, scope: RunDiffOutput['scope'], path: string) =>
  ['runs', 'diff', runId, scope, 'file', path] as const;

/**
 * A Run's diff (Issue #144): read while the Changes tab shows it, and again while the Run is
 * active (a new result replaces it), like the Run itself. A 404 means no result yet (the client
 * never retries a 4xx).
 */
export function useRunDiff(run: RunOutput, scope: RunDiffOutput['scope']) {
  return useQuery({
    queryKey: runDiffKey(run.id, scope),
    queryFn: () => api.getRunDiff(run.id, scope),
    refetchInterval: pollIntervalFor([run]),
    refetchIntervalInBackground: false,
  });
}

/**
 * One file of a Run's diff with its patch (Issue #144), loaded only once the file is expanded
 * (`enabled`), so a large diff loads per file.
 */
export function useRunDiffFile(
  runId: string,
  scope: RunDiffOutput['scope'],
  path: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: runDiffFileKey(runId, scope, path),
    queryFn: () => api.getRunDiffFile(runId, scope, path),
    enabled,
  });
}

/** Reads the open files of a Run's diff again, e.g. after the diff itself changed. */
export function useRefreshRunDiffFiles(runId: string, scope: RunDiffOutput['scope']) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [...runDiffKey(runId, scope), 'file'] });
}
