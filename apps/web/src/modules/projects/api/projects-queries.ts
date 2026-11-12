'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type CreateProjectRequest } from '../../../platform/api';

/** The one cache entry for the project list; TanStack Query owns this server state. */
const PROJECTS_QUERY_KEY = ['projects'] as const;

/** The project list, newest first, as the API orders it. */
export function useProjects() {
  return useQuery({ queryKey: PROJECTS_QUERY_KEY, queryFn: api.listProjects });
}

/** Creates a project, then refetches the list so it shows the new project without a reload. */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateProjectRequest) => api.createProject(request),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROJECTS_QUERY_KEY }),
  });
}
