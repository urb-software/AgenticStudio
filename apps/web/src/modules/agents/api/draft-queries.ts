'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, ApiError, type AgentDraftOutput } from '../../../platform/api';
import { SNAPSHOT } from './agents-queries';

const DRAFT_KEY = ['agents', 'editor', 'draft'] as const;
const DRAFT_FILE_KEY = ['agents', 'editor', 'draft-file'] as const;

/** The Draft: refetched on window focus, so a change made elsewhere shows as a newer `version`. */
export function useDraft() {
  return useQuery({ queryKey: DRAFT_KEY, queryFn: api.getAgentDraft });
}

/** One file as the Draft holds it (its own content, or the base commit's for an untouched one). */
export function useAgentDraftFile(path: string | undefined) {
  return useQuery({
    queryKey: [...DRAFT_FILE_KEY, path] as const,
    queryFn: () => api.getAgentDraftFile(path ?? ''),
    enabled: path !== undefined,
    ...SNAPSHOT,
  });
}

/** Reads the Draft and its files again, after it changed elsewhere. */
export function useReloadDraft() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    queryClient.removeQueries({ queryKey: DRAFT_FILE_KEY });
    await queryClient.invalidateQueries({ queryKey: DRAFT_KEY, exact: true });
  }, [queryClient]);
}

const DRAFT_PROBLEMS = {
  conflict: 'urn:agentic-studio:problem:agent-draft-conflict',
  baseMissing: 'urn:agentic-studio:problem:agent-draft-base-missing',
  noBase: 'urn:agentic-studio:problem:agent-draft-no-base',
} as const;

export type DraftFailure = {
  kind: 'conflict' | 'base-missing' | 'no-base' | 'other';
  message: string;
};

/** What a failed Draft write says, with the two 409 reasons that each need their own advice. */
export function draftFailureOf(error: unknown): DraftFailure {
  const problem = error instanceof ApiError ? error.problem : undefined;
  if (problem?.type === DRAFT_PROBLEMS.conflict) {
    return {
      kind: 'conflict',
      message:
        'Another change to the Draft landed while this one was being made. Reload the Draft, then try again.',
    };
  }
  if (problem?.type === DRAFT_PROBLEMS.baseMissing) {
    return {
      kind: 'base-missing',
      message:
        'The commit this Draft began from is no longer in the Repository. Discard the Draft to start again.',
    };
  }
  if (problem?.type === DRAFT_PROBLEMS.noBase) {
    return {
      kind: 'no-base',
      message: 'The Repository has no fetched commit to start a Draft from yet.',
    };
  }
  return {
    kind: 'other',
    message: problem?.detail || 'The Draft could not be changed. Try again.',
  };
}

/**
 * A write to the Draft: its answer is the new Draft, which replaces the cached one. A refused
 * write that lost a race reads the Draft again so the view can say it changed.
 */
function useDraftWrite<Variables>(
  write: (variables: Variables) => Promise<AgentDraftOutput>,
  applied?: (draft: AgentDraftOutput, variables: Variables) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: (draft, variables) => {
      queryClient.setQueryData(DRAFT_KEY, draft);
      applied?.(draft, variables);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: DRAFT_KEY, exact: true });
      }
    },
  });
}

type SaveVariables = { path: string; text: string } | { path: string; contentBase64: string };

/** Stores a file in the Draft; a text save puts its text where the open file reads it. */
export function useSaveDraftFile(applied?: (draft: AgentDraftOutput, path: string) => void) {
  const queryClient = useQueryClient();
  return useDraftWrite(
    (variables: SaveVariables) => api.saveAgentDraftFile(variables),
    (draft, variables) => {
      if ('text' in variables) {
        queryClient.setQueryData([...DRAFT_FILE_KEY, variables.path], {
          commit: draft.baseCommit ?? '',
          path: variables.path,
          kind: 'text',
          content: variables.text,
        });
      } else {
        queryClient.removeQueries({ queryKey: [...DRAFT_FILE_KEY, variables.path] });
      }
      applied?.(draft, variables.path);
    },
  );
}

/** Drops the cached content of every Draft file but `keep`, which a write of this tab has just set. */
export function useDropDraftFilesExcept() {
  const queryClient = useQueryClient();
  return useCallback(
    (keep: string | undefined) =>
      queryClient.removeQueries({
        queryKey: DRAFT_FILE_KEY,
        predicate: (query) => query.queryKey[3] !== keep,
      }),
    [queryClient],
  );
}

/** Drops the cached content of the Draft's files, which a move, a revert or a delete changes. */
function useForgetDraftFiles() {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.removeQueries({ queryKey: DRAFT_FILE_KEY }), [queryClient]);
}

export function useMoveDraftFile(applied?: (draft: AgentDraftOutput, to: string) => void) {
  const forget = useForgetDraftFiles();
  return useDraftWrite(
    (variables: { from: string; to: string }) =>
      api.moveAgentDraftFile(variables.from, variables.to),
    (draft, variables) => {
      forget();
      applied?.(draft, variables.to);
    },
  );
}

export function useRevertDraftFile(applied?: (draft: AgentDraftOutput, path: string) => void) {
  const forget = useForgetDraftFiles();
  return useDraftWrite(api.revertAgentDraftFile, (draft, path) => {
    forget();
    applied?.(draft, path);
  });
}

export function useDeleteDraftFile(applied?: (draft: AgentDraftOutput, path: string) => void) {
  const forget = useForgetDraftFiles();
  return useDraftWrite(api.deleteAgentDraftFile, (draft, path) => {
    forget();
    applied?.(draft, path);
  });
}

export function useDiscardDraft(applied?: (draft: AgentDraftOutput) => void) {
  const forget = useForgetDraftFiles();
  return useDraftWrite(
    () => api.discardAgentDraft(),
    (draft) => {
      forget();
      applied?.(draft);
    },
  );
}
