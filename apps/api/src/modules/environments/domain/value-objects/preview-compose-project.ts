import { PreviewHostname } from './preview-hostname.js';

/** The names a Project's Preview carries on the host: its Compose project and its socket label. */
export class PreviewComposeProject {
  private constructor(
    readonly value: string,
    readonly label: string,
  ) {}

  /** `projectId` is a UUID: `preview-<32 hex>` and `preview-<first 12 hex>`, as in the hostname. */
  static of(projectId: string): PreviewComposeProject {
    const hex = projectId.replaceAll('-', '').toLowerCase();
    return new PreviewComposeProject(
      `preview-${hex}`,
      `preview-${hex.slice(0, PreviewHostname.ID_DIGITS)}`,
    );
  }
}
