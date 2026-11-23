'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type PreviewOutput,
  type SavePreviewSettingsRequest,
  type SavePreviewSettingsResponseOutput,
} from '../../../platform/api';

/** One project's Preview: its settings, hostname and whether the Repository can be read. */
const previewKey = (projectId: string) => ['projects', projectId, 'preview'] as const;

export function usePreview(projectId: string) {
  return useQuery({ queryKey: previewKey(projectId), queryFn: () => api.getPreview(projectId) });
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
