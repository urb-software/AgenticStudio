/**
 * Where a Project's Preview is served: `preview-<first 12 hex of the project id>.<domain>`. The
 * name follows the Project's id, so a rename does not move it, and its label stays far below the
 * 63 characters a DNS label may have.
 */
export class PreviewHostname {
  /** Hex digits of the project id in the label. */
  static readonly ID_DIGITS = 12;

  private constructor(readonly value: string) {}

  /** `domain` is a validated DNS name; `projectId` a UUID. */
  static of(projectId: string, domain: string): PreviewHostname {
    const digits = projectId.replace(/-/g, '').slice(0, PreviewHostname.ID_DIGITS).toLowerCase();
    return new PreviewHostname(`preview-${digits}.${domain}`);
  }
}
