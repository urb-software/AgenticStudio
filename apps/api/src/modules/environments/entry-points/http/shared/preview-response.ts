import {
  previewRefusedProblemSchema,
  previewSchema,
  savePreviewSettingsResponseSchema,
} from '@agentic-studio/contracts';
import { createZodDto } from 'nestjs-zod';
import type { PreviewView } from '../../../application/preview-view.js';

export class PreviewDto extends createZodDto(previewSchema.meta({ id: 'Preview' })) {}

export class SavePreviewSettingsResponseDto extends createZodDto(
  savePreviewSettingsResponseSchema.meta({ id: 'SavePreviewSettingsResponse' }),
) {}

/** The 422 of a save, for the OpenAPI document. */
export class PreviewRefusedProblemDto extends createZodDto(
  previewRefusedProblemSchema.meta({ id: 'PreviewRefusedProblem' }),
) {}

export function toPreviewResponse(view: PreviewView): PreviewDto {
  return {
    settings: view.settings
      ? { ...view.settings, updatedAt: view.settings.updatedAt.toISOString() }
      : null,
    hostname: view.hostname,
    ...(view.hostnameUnavailable ? { hostnameUnavailable: view.hostnameUnavailable } : {}),
    repository: view.repository,
  };
}
