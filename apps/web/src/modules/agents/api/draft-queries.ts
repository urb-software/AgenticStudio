'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api, ApiError, type AgentDraftOutput } from '../../../platform/api';
import { SNAPSHOT, useRefreshAgents, useReloadEditor } from './agents-queries';

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

const PUBLISH_PROBLEMS = {
  moved: 'urn:agentic-studio:problem:repository-moved',
  nothing: 'urn:agentic-studio:problem:nothing-to-publish',
  running: 'urn:agentic-studio:problem:publish-running',
  writeRefused: 'urn:agentic-studio:problem:write-refused',
  problems: 'urn:agentic-studio:problem:publish-problems',
  outside: 'urn:agentic-studio:problem:publish-path-outside-definitions',
  failed: 'urn:agentic-studio:problem:publish-failed',
  notConfigured: 'urn:agentic-studio:problem:publish-not-configured',
  unreadable: 'urn:agentic-studio:problem:agent-files-unreadable',
  notJudged: 'urn:agentic-studio:problem:draft-not-judged',
} as const;

/** One problem of the Draft, as a refused publish lists it: of an agent or of a skill. */
export type PublishProblem = {
  agent: string | null;
  skill: string | null;
  path: string;
  key: string | null;
  message: string;
};

/** Why a publish was refused or failed, in words for the operator, and what each one needs. */
export type PublishFailure = { message: string } & (
  | {
      kind:
        | 'conflict'
        | 'repository-moved'
        | 'base-missing'
        | 'no-base'
        | 'nothing'
        | 'running'
        | 'write-refused'
        | 'not-configured'
        | 'unreadable'
        | 'not-judged'
        | 'failed'
        | 'invalid'
        | 'other';
    }
  | { kind: 'problems'; problems: PublishProblem[] }
  | { kind: 'outside-definitions'; paths: string[] }
);

/** An array member of a problem document beyond the RFC 9457 ones, or an empty list. */
function listMember(problem: unknown, member: string): unknown[] {
  const value =
    typeof problem === 'object' && problem !== null
      ? (problem as Record<string, unknown>)[member]
      : undefined;
  return Array.isArray(value) ? value : [];
}

function publishProblemsOf(problem: unknown): PublishProblem[] {
  const read = (member: string, owner: 'agent' | 'skill') =>
    listMember(problem, member).flatMap((item) => {
      if (typeof item !== 'object' || item === null) return [];
      const { path, key, message, ...rest } = item as Record<string, unknown>;
      if (typeof path !== 'string' || typeof message !== 'string') return [];
      const name = rest[owner];
      const owned = typeof name === 'string' ? name : '';
      return [
        {
          agent: owner === 'agent' ? owned : null,
          skill: owner === 'skill' ? owned : null,
          path,
          key: typeof key === 'string' ? key : null,
          message,
        },
      ];
    });
  return [...read('problems', 'agent'), ...read('skillProblems', 'skill')];
}

/** What a failed publish says. Each refusal of the API has its own plain message. */
export function publishFailureOf(error: unknown): PublishFailure {
  const problem = error instanceof ApiError ? error.problem : undefined;
  switch (problem?.type) {
    case DRAFT_PROBLEMS.conflict:
      return { kind: 'conflict', message: draftFailureOf(error).message };
    case DRAFT_PROBLEMS.baseMissing:
      return { kind: 'base-missing', message: draftFailureOf(error).message };
    case DRAFT_PROBLEMS.noBase:
      return { kind: 'no-base', message: draftFailureOf(error).message };
    case PUBLISH_PROBLEMS.moved:
      return {
        kind: 'repository-moved',
        message:
          'The Repository moved on since this Draft began, so the Draft cannot be published again: a Draft is never moved onto a newer commit. If an earlier publish reached the Git host, its changes are already in the Repository and this Draft still holds them. Copy anything you still need from it first: discarding the Draft deletes it for good. Then discard the Draft and make again any change that is missing.',
      };
    case PUBLISH_PROBLEMS.nothing:
      return {
        kind: 'nothing',
        message: 'The Draft changes nothing in the Repository, so there is nothing to publish.',
      };
    case PUBLISH_PROBLEMS.running:
      return {
        kind: 'running',
        message: 'Another publish is running. Wait for it to end, then publish again.',
      };
    case PUBLISH_PROBLEMS.writeRefused:
      return {
        kind: 'write-refused',
        message:
          'The Git host refused the push. Give the Deploy key of the definitions Repository write access on the Git host (for that Repository only), and check that its Integration branch accepts a push from the key. The Draft is kept.',
      };
    case PUBLISH_PROBLEMS.notConfigured:
      return {
        kind: 'not-configured',
        message:
          'Studio has no name and email to author the commit with. Set STUDIO_DEFINITIONS_COMMIT_NAME and STUDIO_DEFINITIONS_COMMIT_EMAIL on the server, restart it, and publish again.',
      };
    case PUBLISH_PROBLEMS.unreadable:
      return {
        kind: 'unreadable',
        message:
          'The files of the Repository cannot be read now, so the Draft could not be checked. Try again in a moment.',
      };
    case PUBLISH_PROBLEMS.notJudged:
      return {
        kind: 'not-judged',
        message:
          'The Draft touches more skills and agents than one check can read, so Studio cannot tell whether it is valid and will not publish it. Split the changes into smaller Drafts.',
      };
    case PUBLISH_PROBLEMS.failed:
      return {
        kind: 'failed',
        message:
          'The push to the Git host failed, and it may still have reached the Git host. The Draft is kept. The next publish will tell: if the Repository has moved on, your changes are probably already there.',
      };
    case PUBLISH_PROBLEMS.problems:
      return {
        kind: 'problems',
        message: 'Fix every problem of the Draft before publishing it.',
        problems: publishProblemsOf(problem),
      };
    case PUBLISH_PROBLEMS.outside:
      return {
        kind: 'outside-definitions',
        message:
          'Publishing writes only below agents/ and skills/. Revert the changes outside them, or make them with your own Git.',
        paths: listMember(problem, 'paths').filter((p): p is string => typeof p === 'string'),
      };
    default:
      break;
  }
  if (error instanceof ApiError && error.status === 400) {
    const field = problem?.errors?.find((item) => item.path === 'message') ?? problem?.errors?.[0];
    return {
      kind: 'invalid',
      message: field?.message || problem?.detail || 'The message was not accepted.',
    };
  }
  if (unanswered(error)) {
    return {
      kind: 'failed',
      message:
        'No answer arrived, or the server failed, and the publish may still have gone through to the Git host. Reload the Draft to see whether it is now empty or the Repository moved on: your changes are then probably already there.',
    };
  }
  return {
    kind: 'other',
    message: problem?.detail || 'The Draft could not be published. Try again.',
  };
}

/**
 * Publishes the Draft. A success reads the Draft, the tree and the agents again (the Repository
 * has a new commit) and drops the cached Draft files; the files read at a commit are keyed by it,
 * so none of them is stale. A 409 reads the Draft again so the page shows what changed.
 */
export function usePublishDraft() {
  const queryClient = useQueryClient();
  const reloadEditor = useReloadEditor();
  const refreshAgents = useRefreshAgents();
  return useMutation({
    mutationFn: api.publishAgentDraft,
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: DRAFT_FILE_KEY });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: DRAFT_KEY, exact: true }),
        reloadEditor(),
        refreshAgents(),
      ]);
    },
    onError: async (error) => {
      if (error instanceof ApiError && error.status === 409) {
        await queryClient.invalidateQueries({ queryKey: DRAFT_KEY, exact: true });
      } else if (unanswered(error)) {
        // The push may have reached the Git host: read what the page shows again.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: DRAFT_KEY, exact: true }),
          reloadEditor(),
        ]);
      }
    },
  });
}

/** No answer, or a server failure the API has no name for: the publish may have happened. */
function unanswered(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}
