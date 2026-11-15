'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type RunOutput, type StartRunRequest } from '../../../platform/api';
import { pollIntervalFor } from '../components/run-presentation';

/** Every cache entry of this module starts with this key, so a start can refresh them all. */
const RUNS_KEY = ['runs'] as const;

/** One project's Runs, newest first. */
const projectRunsKey = (projectId: string) => ['runs', 'project', projectId] as const;

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

/** One Run; polled while it is active and the tab is visible, never once it is finished. */
export function useRun(runId: string) {
  return useQuery({
    queryKey: runKey(runId),
    queryFn: () => api.getRun(runId),
    refetchInterval: (query) => pollIntervalFor(query.state.data && [query.state.data]),
    refetchIntervalInBackground: false,
  });
}

/** The Run's project (its name and link on the Run page). */
export function useRunProject(projectId: string | undefined) {
  return useQuery({
    queryKey: runProjectKey(projectId ?? ''),
    queryFn: () => api.getProject(projectId!),
    enabled: projectId !== undefined,
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
