'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../../platform/api';
import { useCreateProject } from '../../projects';

/** The definitions Repository: `{ project: null }` until it is created. */
const DEFINITIONS_REPOSITORY_KEY = ['agents', 'definitions-repository'] as const;

/** The name of the Project that holds the definitions; the operator can see it in Projects. */
export const DEFINITIONS_PROJECT_NAME = 'Agent definitions';

export function useDefinitionsRepository() {
  return useQuery({
    queryKey: DEFINITIONS_REPOSITORY_KEY,
    queryFn: api.getDefinitionsRepository,
  });
}

/**
 * Creates the Project with `kind: definitions`. Its Repository is connected afterwards with the
 * existing connection steps. The answer holds only the new Project's id, so the page reads the
 * definitions Repository again; the mutation stays pending until it has.
 */
export function useCreateDefinitionsProject() {
  const queryClient = useQueryClient();
  const create = useCreateProject();
  return useMutation({
    mutationFn: () => create.mutateAsync({ name: DEFINITIONS_PROJECT_NAME, kind: 'definitions' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: DEFINITIONS_REPOSITORY_KEY }),
    // 409 (another tab created it first): the page reads the server's state again.
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: DEFINITIONS_REPOSITORY_KEY });
      }
    },
  });
}
