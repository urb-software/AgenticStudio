'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { LogRow } from '@/shared/components/log-viewer';
import {
  ApiError,
  api,
  type PreviewOutput,
  type SavePreviewSettingsRequest,
  type SavePreviewSettingsResponseOutput,
} from '../../../platform/api';

/** One project's Preview: its settings, hostname and whether the Repository can be read. */
const previewKey = (projectId: string) => ['projects', projectId, 'preview'] as const;

export const PREVIEW_BUILDING_POLL_MS = 2_000;
export const PREVIEW_IDLE_POLL_MS = 15_000;

/** Polled fast while a build is under way and slowly otherwise, never in a hidden tab. */
export function usePreview(projectId: string) {
  return useQuery({
    queryKey: previewKey(projectId),
    queryFn: () => api.getPreview(projectId),
    refetchInterval: (query) =>
      query.state.data?.state === 'building' ? PREVIEW_BUILDING_POLL_MS : PREVIEW_IDLE_POLL_MS,
    refetchIntervalInBackground: false,
  });
}

/** Asks for a build; the mutation stays pending until the Preview has been read again. */
export function useRequestPreviewBuild(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.requestPreviewBuild(projectId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: previewKey(projectId) }),
  });
}

export const PREVIEW_LOG_POLL_MS = 2_000;
const PREVIEW_LOG_PAGE = 500;

export type PreviewBuildLog = {
  rows: readonly LogRow[];
  /** True once the build is over and every line has been read. */
  complete: boolean;
  /** True when the log reached its size cap. */
  truncated: boolean;
  /** True while the last read failed; the next one is tried anyway. */
  failing: boolean;
  /** True when the server has no such log (404): nothing will come. */
  unavailable: boolean;
};

const EMPTY_LOG: PreviewBuildLog = {
  rows: [],
  complete: false,
  truncated: false,
  failing: false,
  unavailable: false,
};

/**
 * A build's log, read by polling: pages after the last `seq` it has, back to back while `next`
 * says more follow, then every 2 s until the server says `final` with nothing more. The rows
 * array only grows (earlier row objects stay), which is what the `LogViewer` lays out cheaply.
 */
export function usePreviewBuildLog(projectId: string, buildId: string): PreviewBuildLog {
  const [log, setLog] = useState<{ buildId: string; value: PreviewBuildLog }>({
    buildId,
    value: EMPTY_LOG,
  });
  const current = log.buildId === buildId ? log.value : EMPTY_LOG;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    let rows: LogRow[] = [];

    const publish = (change: Partial<PreviewBuildLog>) => {
      if (cancelled) return;
      setLog((previous) => ({
        buildId,
        value: { ...(previous.buildId === buildId ? previous.value : EMPTY_LOG), rows, ...change },
      }));
    };

    const read = async () => {
      // Not in a hidden tab: look again once it may be visible.
      if (typeof document !== 'undefined' && document.hidden) {
        timer = setTimeout(() => void read(), PREVIEW_LOG_POLL_MS);
        return;
      }
      try {
        const page = await api.listPreviewBuildEvents(projectId, buildId, after, PREVIEW_LOG_PAGE);
        if (cancelled) return;
        if (page.events.length > 0) {
          rows = rows.concat(
            page.events.map((event) => ({
              key: String(event.seq),
              text: event.text,
              tone: event.stream === 'controller' ? ('system' as const) : ('plain' as const),
            })),
          );
          after = page.events.at(-1)!.seq;
        }
        const complete = page.final && page.next === undefined;
        publish({ complete, truncated: page.truncated, failing: false });
        if (complete) return;
        timer = setTimeout(() => void read(), page.next === undefined ? PREVIEW_LOG_POLL_MS : 0);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          publish({ failing: false, unavailable: true });
          return;
        }
        publish({ failing: true });
        timer = setTimeout(() => void read(), PREVIEW_LOG_POLL_MS);
      }
    };

    void read();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [projectId, buildId]);

  return current;
}

/**
 * The API judges the Compose file before it saves. The answer is the Preview, so the page takes it
 * at once; `removedPorts` stays with the mutation's result for the page to show.
 */
export function useSavePreviewSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: SavePreviewSettingsRequest) =>
      api.savePreviewSettings(projectId, request),
    onSuccess: (saved: SavePreviewSettingsResponseOutput) => {
      const preview: PreviewOutput = {
        settings: saved.settings,
        hostname: saved.hostname,
        ...(saved.hostnameUnavailable ? { hostnameUnavailable: saved.hostnameUnavailable } : {}),
        repository: saved.repository,
        state: saved.state,
        running: saved.running,
        latestBuild: saved.latestBuild,
        latestChange: saved.latestChange,
        controller: saved.controller,
      };
      queryClient.setQueryData<PreviewOutput>(previewKey(projectId), preview);
    },
  });
}

/** Removes the settings; the query then shows none. */
export function useRemovePreviewSettings(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.removePreviewSettings(projectId),
    onSuccess: () => {
      queryClient.setQueryData<PreviewOutput>(previewKey(projectId), (preview) =>
        preview ? { ...preview, settings: null } : preview,
      );
    },
  });
}
