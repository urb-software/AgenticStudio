import type { PreviewRepositoryReason } from '../domain/errors/preview-settings-errors.js';
import type { PreviewSettings } from '../domain/entities/preview-settings.js';
import { PreviewHostname } from '../domain/value-objects/preview-hostname.js';

/** What the operator sees of a Project's Preview: the settings, the hostname and whether the Repository can be read. */
export interface PreviewView {
  settings: { composeFile: string; service: string; port: number; updatedAt: Date } | null;
  /** `null` while no preview domain is configured. */
  hostname: string | null;
  hostnameUnavailable?: 'not_configured';
  repository: {
    ready: boolean;
    reason?: PreviewRepositoryReason;
  };
}

export function previewView(input: {
  projectId: string;
  settings: PreviewSettings | null;
  domain: string | null;
  repositoryReason: PreviewRepositoryReason | null;
}): PreviewView {
  const { settings, domain, repositoryReason } = input;
  return {
    settings: settings
      ? {
          composeFile: settings.composeFile,
          service: settings.service,
          port: settings.port,
          updatedAt: new Date(settings.updatedAt),
        }
      : null,
    ...(domain === null
      ? { hostname: null, hostnameUnavailable: 'not_configured' as const }
      : { hostname: PreviewHostname.of(input.projectId, domain).value }),
    repository:
      repositoryReason === null ? { ready: true } : { ready: false, reason: repositoryReason },
  };
}
