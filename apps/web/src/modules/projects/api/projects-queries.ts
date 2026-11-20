'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  api,
  ApiError,
  type ConnectRepositoryRequest,
  type CreateProjectRequest,
  type EnvironmentFileInfoOutput,
  type ProjectDetailOutput,
  type RepositoryOutput,
  type SetEnvironmentFileRequest,
  type VerifyRepositoryRequest,
} from '../../../platform/api';

/** The one cache entry for the project list; TanStack Query owns this server state. */
const PROJECTS_QUERY_KEY = ['projects'] as const;

/** One project's detail (with its Repository summary). */
const projectKey = (projectId: string) => ['projects', projectId] as const;

/** One project's Repository; polled while it is connecting, fetching or disconnecting. */
const repositoryKey = (projectId: string) => ['projects', projectId, 'repository'] as const;

/**
 * How often a connecting, fetching or disconnecting Repository is polled while the tab is
 * visible.
 */
export const REPOSITORY_POLL_MS = 2_000;

/** The project list, newest first, as the API orders it. */
export function useProjects() {
  return useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.listProjects });
}

/** Creates a project, then refetches the list so it shows the new project without a reload. */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateProjectRequest) => api.createProject(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY, exact: true }),
  });
}

/** One project with a summary of its Repository (`repository: null` when none). */
export function useProject(projectId: string) {
  return useQuery({ queryKey: projectKey(projectId), queryFn: () => api.getProject(projectId) });
}

/** The states in which background work runs on the server, so the Repository is polled. */
const BUSY_STATES: readonly string[] = ['connecting', 'fetching', 'disconnecting'];

/**
 * Refetched while `connecting`, `fetching` or `disconnecting` and the tab is visible; it stops
 * on any other state and on the 404 that says the Repository is gone. Other errors keep the
 * polling going.
 */
export function useRepository(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: repositoryKey(projectId),
    queryFn: () => api.getRepository(projectId),
    enabled,
    refetchInterval: (query) =>
      !(query.state.error instanceof ApiError && query.state.error.status === 404) &&
      BUSY_STATES.includes(query.state.data?.state ?? '')
        ? REPOSITORY_POLL_MS
        : false,
    refetchIntervalInBackground: false,
  });
}

/**
 * Connects a Repository (also Retry). The 201 answer is the Repository in `connecting`; it
 * seeds the polled query, and the project detail is refetched for its summary.
 */
export function useConnectRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: ConnectRepositoryRequest) => api.connectRepository(projectId, request),
    onSuccess: async (repository: RepositoryOutput) => {
      queryClient.setQueryData(repositoryKey(projectId), repository);
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
    },
  });
}

/**
 * A read of the Repository still in flight (e.g. a refetch on focus) is cancelled first: its
 * older `ready` answer would otherwise replace `fetching`, stop the polling and look like a
 * fetch that ended ("Already up to date").
 */
export function useFetchRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
      return api.fetchRepository(projectId);
    },
    onSuccess: async (repository: RepositoryOutput) => {
      await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
      queryClient.setQueryData(repositoryKey(projectId), repository);
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
    },
    // 409: the server is ahead of this card (e.g. a fetch already running), so read it again;
    // a `fetching` answer then starts the polling.
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: repositoryKey(projectId), exact: true });
      }
    },
  });
}

/** A 409 reads the Repository again (the server is ahead of the card). */
export function useVerifyRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: VerifyRepositoryRequest) => {
      await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
      return api.verifyRepository(projectId, request);
    },
    onSuccess: async (repository: RepositoryOutput) => {
      await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
      queryClient.setQueryData(repositoryKey(projectId), repository);
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: repositoryKey(projectId), exact: true });
      }
    },
  });
}

/**
 * Forgets the project's Repository once the server no longer has it (a disconnect that
 * completed): the cached Repository goes, the project's summary becomes `null` at once (the
 * card shows its empty state) and is then read again from the server.
 */
export function useForgetRepository(projectId: string) {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
    queryClient.removeQueries({ queryKey: repositoryKey(projectId), exact: true });
    queryClient.setQueryData<ProjectDetailOutput>(projectKey(projectId), (project) =>
      project ? { ...project, repository: null } : project,
    );
    await queryClient.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
  }, [queryClient, projectId]);
}

/**
 * A read still in flight is cancelled first, so an older answer cannot replace the new state.
 * `onDisconnected` runs inside the mutation after a 204, so it runs even when the caller has
 * unmounted.
 */
export function useDisconnectRepository(projectId: string, onDisconnected: () => void) {
  const queryClient = useQueryClient();
  const forget = useForgetRepository(projectId);
  return useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
      return api.disconnectRepository(projectId);
    },
    onSuccess: async (repository: RepositoryOutput | null) => {
      if (repository === null) {
        onDisconnected();
        await forget();
        return;
      }
      await queryClient.cancelQueries({ queryKey: repositoryKey(projectId), exact: true });
      queryClient.setQueryData(repositoryKey(projectId), repository);
      await queryClient.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
    },
  });
}

/** Refetches the project detail (its Repository summary) after the Repository changed state. */
export function useRefreshProject(projectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: projectKey(projectId), exact: true });
}

/** One project's Environment file setting. */
const environmentFileKey = (projectId: string) =>
  ['projects', projectId, 'environment-file'] as const;

/**
 * The project's Environment file as the operator may see it (path, size, last change), or
 * `null` when none is set. The content is never sent to the browser.
 */
export function useEnvironmentFile(projectId: string) {
  return useQuery({
    queryKey: environmentFileKey(projectId),
    queryFn: () => api.getEnvironmentFile(projectId),
  });
}

/**
 * The request holds the content, so the mutation is dropped from the mutation cache as soon as
 * nothing observes it (`gcTime: 0`; the dialog resets it when it closes): the content is not
 * kept in the browser after the save.
 */
export function useSetEnvironmentFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: (request: SetEnvironmentFileRequest) => api.setEnvironmentFile(projectId, request),
    onSuccess: (info: EnvironmentFileInfoOutput) => {
      queryClient.setQueryData(environmentFileKey(projectId), info);
    },
  });
}

/** Removes the Environment file; the query then holds `null`. */
export function useRemoveEnvironmentFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.removeEnvironmentFile(projectId),
    onSuccess: () => {
      queryClient.setQueryData(environmentFileKey(projectId), null);
    },
  });
}
