import {
  type PreviewRefusal,
  previewBuildEventsSchema,
  previewBuildSchema,
  previewRefusedProblemSchema,
  previewSchema,
  savePreviewSettingsResponseSchema,
} from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import type { GetPreviewBuildEventsResult } from '../../../application/features/get-preview-build-events/handler.js';
import type { PreviewBuildView, PreviewView } from '../../../application/preview-view.js';

export class PreviewDto extends createZodDto(previewSchema.meta({ id: 'Preview' })) {}

export class SavePreviewSettingsResponseDto extends createZodDto(
  savePreviewSettingsResponseSchema.meta({ id: 'SavePreviewSettingsResponse' }),
) {}

/** The 422 of a save, for the OpenAPI document. */
export class PreviewRefusedProblemDto extends createZodDto(
  previewRefusedProblemSchema.meta({ id: 'PreviewRefusedProblem' }),
) {}

export class PreviewBuildDto extends createZodDto(
  previewBuildSchema.meta({ id: 'PreviewBuild' }),
) {}

export class PreviewBuildEventsDto extends createZodDto(
  previewBuildEventsSchema.meta({ id: 'PreviewBuildEvents' }),
) {}

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

export function toPreviewBuildResponse(build: PreviewBuildView): PreviewBuildDto {
  return {
    ...build,
    // The refusal codes were validated against the contract when the controller reported them.
    failure:
      build.failure === null
        ? null
        : { ...build.failure, refusals: build.failure.refusals as PreviewRefusal[] },
    requestedAt: build.requestedAt.toISOString(),
    startedAt: iso(build.startedAt),
    finishedAt: iso(build.finishedAt),
  };
}

export function toPreviewBuildEventsResponse(
  page: GetPreviewBuildEventsResult,
): PreviewBuildEventsDto {
  return {
    ...page,
    events: page.events.map((event) => ({ ...event, at: event.at.toISOString() })),
  };
}

export function toPreviewResponse(view: PreviewView): PreviewDto {
  return {
    settings: view.settings
      ? { ...view.settings, updatedAt: view.settings.updatedAt.toISOString() }
      : null,
    hostname: view.hostname,
    ...(view.hostnameUnavailable ? { hostnameUnavailable: view.hostnameUnavailable } : {}),
    repository: view.repository,
    state: view.state,
    running:
      view.running === null ? null : { ...view.running, since: view.running.since.toISOString() },
    latestBuild: view.latestBuild === null ? null : toPreviewBuildResponse(view.latestBuild),
    controller: view.controller,
  };
}
