'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '../../../platform/api';

const WORKFLOWS_KEY = ['workflows', 'list'] as const;
const WORKFLOW_KEY = ['workflows', 'detail'] as const;

/** The Workflows as the API lists them; refetched on window focus, which the API answers from memory. */
export function useWorkflows() {
  return useQuery({ queryKey: WORKFLOWS_KEY, queryFn: api.listWorkflows });
}

/**
 * One Workflow at `commit`, the commit of the list it was opened from. The folder at a commit
 * never changes, but the Providers and the agents it names are judged again by the API, so the
 * answer is read again on window focus; a new commit is a new key.
 */
export function useWorkflow(name: string, commit: string | null) {
  return useQuery({
    queryKey: [...WORKFLOW_KEY, commit, name] as const,
    queryFn: () => api.getWorkflow(name),
  });
}
