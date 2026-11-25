'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Whether a failed create is a taken name (the operator can pick another), not a second Project. */
export function isNameConflict(error: unknown): boolean {
  return (
    error instanceof ApiError && error.status === 409 && error.problem?.type !== EXISTS_PROBLEM
  );
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
      if (error instanceof ApiError && error.status === 409 && !isNameConflict(error)) {
        await queryClient.invalidateQueries({ queryKey: DEFINITIONS_REPOSITORY_KEY });
      }
    },
  });
}
