'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, ApiError } from '../../../platform/api';

/** The definitions Repository: `{ project: null }` until it is created. */
const DEFINITIONS_REPOSITORY_KEY = ['agents', 'definitions-repository'] as const;

/** The name offered for the Project that holds the definitions. */
export const DEFINITIONS_PROJECT_NAME = 'Agent definitions';

/** The problem type of a second definitions Repository, which no other name can fix. */
const EXISTS_PROBLEM = 'urn:agentic-studio:problem:definitions-project-exists';

export function useDefinitionsRepository() {
  return useQuery({
    queryKey: DEFINITIONS_REPOSITORY_KEY,
    queryFn: api.getDefinitionsRepository,
  });
}

/** What the form says for a taken name (the API's own 409 text is not about the field). */
const TAKEN_MESSAGE = 'A project with this name already exists. Choose another name.';

/**
 * The message for the name field when a create failed because of the name (a taken name, or one
 * the API rejects), so the operator can change it; undefined for any other failure. A second
 * definitions Repository is a refusal no name can fix.
 */
export function nameProblemOf(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const field = error.problem?.errors?.find((fieldError) => fieldError.path === 'name');
  if (field) return field.message;
  if (error.status === 409 && error.problem?.type !== EXISTS_PROBLEM) return TAKEN_MESSAGE;
  return undefined;
}

/**
 * Creates the Project with `kind: definitions`, named `name`. Its Repository is connected
 * afterwards with the existing connection steps. The answer holds only the new Project's id, so
 * the page reads the definitions Repository again; the mutation stays pending until it has.
 */
export function useCreateDefinitionsProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createProject({ name, kind: 'definitions' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DEFINITIONS_REPOSITORY_KEY }),
    // 409 for a second definitions Repository (created elsewhere): read the server's state again.
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409 && nameProblemOf(error) === undefined) {
        await queryClient.invalidateQueries({ queryKey: DEFINITIONS_REPOSITORY_KEY });
      }
    },
  });
}

/** The Providers with the models an agent may name for each (`default` first). */
export function useProviders() {
  return useQuery({ queryKey: ['agents', 'providers'] as const, queryFn: api.listProviders });
}

/** The agents as the API lists them (the last fetched commit of the definitions Repository). */
const AGENTS_KEY = ['agents', 'list'] as const;
const AGENT_KEY = ['agents', 'detail'] as const;

/** Refetched on window focus (TanStack Query's default), and by `useRefreshAgents`. */
export function useAgents() {
  return useQuery({ queryKey: AGENTS_KEY, queryFn: api.listAgents });
}

/** One agent with its instructions and files; mounted only while the agent is open. */
export function useAgent(name: string) {
  return useQuery({ queryKey: [...AGENT_KEY, name] as const, queryFn: () => api.getAgent(name) });
}

/** Reads the list and the open agent again, e.g. after a fetch brought new commits. */
export function useRefreshAgents() {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: AGENTS_KEY, exact: true }),
        queryClient.invalidateQueries({ queryKey: AGENT_KEY }),
      ]),
    [queryClient],
  );
}

/**
 * What the editor reads. Not refetched on focus: the view shows one commit and switches only
 * when the operator reloads (the editor compares `useAgents()`, which does refetch, to it).
 */
const FILES_KEY = ['agents', 'editor', 'files'] as const;
const EDITOR_AGENTS_KEY = ['agents', 'editor', 'agents'] as const;
const FILE_KEY = ['agents', 'editor', 'file'] as const;

export const SNAPSHOT = { staleTime: Infinity, refetchOnWindowFocus: false } as const;

/** The whole definitions Repository's tree at its last fetched commit. */
export function useAgentFiles() {
  return useQuery({ queryKey: FILES_KEY, queryFn: api.listAgentFiles, ...SNAPSHOT });
}

/** The agents, with their problems, as of the editor's last (re)load: the tree's marks. */
export function useEditorAgents() {
  return useQuery({ queryKey: EDITOR_AGENTS_KEY, queryFn: api.listAgents, ...SNAPSHOT });
}

/** One file at `commit`, the commit the editor shows. */
export function useAgentFile(path: string | undefined, commit: string | undefined) {
  return useQuery({
    queryKey: [...FILE_KEY, commit, path] as const,
    queryFn: () => api.getAgentFile(path ?? '', commit),
    enabled: path !== undefined && commit !== undefined,
    ...SNAPSHOT,
  });
}

/** Reads the tree and the marks again, which moves the editor to the newest commit. */
export function useReloadEditor() {
  const queryClient = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: FILES_KEY, exact: true }),
        queryClient.invalidateQueries({ queryKey: EDITOR_AGENTS_KEY, exact: true }),
      ]),
    [queryClient],
  );
}
