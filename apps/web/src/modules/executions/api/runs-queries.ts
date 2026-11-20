'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AnswerRunRequest,
  api,
  type BringUpToDateRequest,
  type FollowUpRunRequest,
  type LoadReviewCommentsRequest,
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
 * The poll interval for a set of Runs: fast while any is active (or retrying its delivery),
 * slower while one only waits for the operator, and none once all are finished.
 */
function pollIntervalFor(
  runs: readonly RunOutput[] | undefined,
  /** Also follow a pull request refresh under way (the Run page only). */
  followRefresh = false,
): number | false {
  if (!runs) return false;
  // A requested delivery retry moves on without the operator too. a pull request refresh an
  // agent worker is carrying out moves on by itself too; only the Run page follows it (a list
  // cannot tell a refresh no worker will answer).
  if (
    runs.some(
      (run) =>
        UNDER_WAY_STATES.includes(run.state) ||
        run.deliveryRetryRequested ||
        (followRefresh &&
          (run.pullRequest?.refreshing ||
            run.pullRequest?.failingChecksPreparation?.state === 'preparing')),
    )
  ) {
    return ACTIVE_POLL_MS;
  }
  if (runs.some((run) => WAITING_STATES.includes(run.state))) return WAITING_POLL_MS;
  return false;
}

/** The same rule for the summary's counts. */
function summaryPollInterval(summary: RunsSummaryOutput | undefined): number | false {
  if (!summary) return false;
  if (summary.running > 0) return ACTIVE_POLL_MS;
  return summary.waiting > 0 ? WAITING_POLL_MS : false;
}

/** Every cache entry of this module starts with this key, so a start can refresh them all. */
const RUNS_KEY = ['runs'] as const;

const projectRunsKey = (projectId: string) => ['runs', 'project', projectId] as const;

const ALL_RUNS_KEY = ['runs', 'all'] as const;

const RUNS_SUMMARY_KEY = ['runs', 'summary'] as const;

const PROJECTS_KEY = ['runs', 'projects'] as const;

const providersKey = (opening: number) => ['runs', 'providers', opening] as const;

/** The agent side's connection and disk figures. */
const AGENT_WORKER_KEY = ['runs', 'agent-worker'] as const;

const runKey = (runId: string) => ['runs', 'run', runId] as const;

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

export function useAllRuns() {
  return useQuery({
    queryKey: ALL_RUNS_KEY,
    queryFn: api.listRuns,
    refetchInterval: (query) => pollIntervalFor(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/** How often the agent worker's disk figures are read again while the page is visible. */
const AGENT_WORKER_POLL_MS = 30_000;

/**
 * The worker measures at most every ten minutes, so a slow poll is enough; the page works
 * without it (a failed read shows nothing).
 */
export function useAgentWorker() {
  return useQuery({
    queryKey: AGENT_WORKER_KEY,
    queryFn: api.getAgentWorker,
    refetchInterval: AGENT_WORKER_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Two counts instead of every Run, polled like the lists. */
export function useRunsSummary() {
  return useQuery({
    queryKey: RUNS_SUMMARY_KEY,
    queryFn: api.getRunsSummary,
    refetchInterval: (query) => summaryPollInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

/**
 * Its own cache entry for the same reason as {@link useRunProject}: the projects module's
 * queries are private to it.
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
 * A cache entry of its own: the projects module's query is private to it, and importing it here
 * would make a cycle (projects composes this module's Runs section).
 */
export function useRunProject(projectId: string | undefined) {
  return useQuery({
    queryKey: runProjectKey(projectId ?? ''),
    queryFn: () => api.getProject(projectId!),
    enabled: projectId !== undefined,
  });
}

/**
 * Each opening has its own cache entry (`opening` counts them), so it starts with no answer and
 * never shows an earlier opening's; finished entries are dropped (`gcTime: 0`).
 * The server's start check and the agent worker's own check stay authoritative.
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

/** The mutation stays pending until the Run is read (frontend.md §4). */
export function useRetryDelivery(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.retryRunDelivery(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
  });
}

/** A 409 reads the Run again at once. */
export function useAnswerRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AnswerRunRequest) => api.answerRun(runId, request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
    // The Run moved on (answered elsewhere, cancelled): read it at once, not at the next poll.
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/** A 409 (the Run cannot take one now) reads the Run again at once, so the page says why. */
export function useFollowUpRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: FollowUpRunRequest) => api.followUpRun(runId, request),
    onSuccess: async () => {
      // A sent Follow-up removes the prepared one, and the loaded Review comments it was
      // prepared from.
      queryClient.removeQueries({ queryKey: preparedFollowUpKey(runId) });
      queryClient.removeQueries({ queryKey: reviewCommentsKey(runId) });
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/** A 409 (the Run cannot take a Follow-up now) reads the Run again at once, so the page says why. */
export function useBringUpToDateRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: BringUpToDateRequest) => api.bringUpToDateRun(runId, request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/**
 * `onOpen` (the Run page opening) is limited by the API to once a minute. The 202 answer
 * replaces the cached Run, so the page polls it until an agent worker has reported what it read.
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

const reviewCommentsKey = (runId: string) => ['review-comments', runId] as const;

/**
 * Followed every two seconds while a load is under way; otherwise read on open or focus, which
 * never changes what the operator is looking at: the page keys its selection to the load it
 * belongs to.
 */
export function useReviewComments(runId: string, enabled: boolean) {
  return useQuery({
    queryKey: reviewCommentsKey(runId),
    queryFn: () => api.getRunReviewComments(runId),
    enabled,
    refetchInterval: (query) => (query.state.data?.loading ? ACTIVE_POLL_MS : false),
    refetchIntervalInBackground: false,
  });
}

/**
 * "Load review comments": asks the agent worker to read the pull request's comments. The 202
 * answer (the set as it is now, marked as loading) replaces the cached one, so the page follows
 * the load. Nothing is sent to an agent.
 */
export function useLoadReviewComments(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: LoadReviewCommentsRequest) => api.loadRunReviewComments(runId, request),
    onSuccess: (comments) => {
      queryClient.setQueryData(reviewCommentsKey(runId), comments);
    },
    // The Run changed (its pull request is gone): read it at once, so the page says so.
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

const preparedFollowUpKey = (runId: string) => ['prepared-follow-up', runId] as const;

/**
 * "Send failing checks to the agent": asks the agent worker to read the logs of the failed Pull
 * request checks. The 202 answer (the Run, marked as preparing) replaces the cached Run, so the
 * page follows it until the draft is ready. Nothing is sent to an agent.
 */
export function usePrepareFailingChecks(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.prepareRunFailingChecks(runId),
    onSuccess: (run: RunOutput) => {
      queryClient.setQueryData(runKey(run.id), run);
    },
    // The Run changed (its checks passed meanwhile): read it at once, so the page says so.
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/**
 * The Follow-up prepared from the failing checks, for the operator's review; only while the Run
 * says one is ready. Read once per preparation, never refetched under the operator's edits.
 */
export function usePreparedFollowUp(runId: string, enabled: boolean) {
  return useQuery({
    queryKey: preparedFollowUpKey(runId),
    queryFn: () => api.getRunPreparedFollowUp(runId),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Discards the prepared Follow-up without sending it; the Run is read again. */
export function useDiscardPreparedFollowUp(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.discardRunPreparedFollowUp(runId),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: preparedFollowUpKey(runId) });
      await queryClient.invalidateQueries({ queryKey: runKey(runId) });
    },
  });
}

/** A 409 (resumed elsewhere) reads the Run again at once. */
export function useResumeRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.resumeRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: runKey(runId) });
      }
    },
  });
}

/**
 * Starts a Run. The answer is the new Run's id, which the caller opens; the Run itself is read by
 * its page, and every Run list of this module is read again.
 */
export function useStartRun(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: StartRunRequest) => api.startRun(projectId, request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
  });
}

/**
 * Cancels a Run. The answer says whether it was cancelled at once or a cancel was requested that
 * the agent worker still has to confirm; the Run page shows either from the Run it reads. The Run
 * and every Run list are read again, and the mutation stays pending until the Run is read.
 */
export function useCancelRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: RUNS_KEY }),
    // A refusal (e.g. the Run finished meanwhile) also means the page's Run is out of date.
    onError: () => queryClient.invalidateQueries({ queryKey: runKey(runId) }),
  });
}

const runStepsKey = (runId: string) => ['runs', 'steps', runId] as const;

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

/** A Run's diff of one scope, and one file of it. */
const runDiffKey = (runId: string, scope: RunDiffOutput['scope']) =>
  ['runs', 'diff', runId, scope] as const;
const runDiffFileKey = (runId: string, scope: RunDiffOutput['scope'], path: string) =>
  ['runs', 'diff', runId, scope, 'file', path] as const;

/**
 * A Run's diff: read while the Changes tab shows it, and again while the Run is active (a new
 * result replaces it), like the Run itself. A 404 means no result yet (the client never retries
 * a 4xx).
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
 * One file of a Run's diff with its patch, loaded only once the file is expanded (`enabled`), so
 * a large diff loads per file.
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
