/** Where a Project's Preview is served: `preview-<first 12 hex of the project id>.<domain>`. */
export class PreviewHostname {
  static readonly ID_DIGITS = 12;

  private constructor(readonly value: string) {}

  /** `domain` is a validated DNS name; `projectId` a UUID. */
  static of(projectId: string, domain: string): PreviewHostname {
    const digits = projectId.replace(/-/g, '').slice(0, PreviewHostname.ID_DIGITS).toLowerCase();
    return new PreviewHostname(`preview-${digits}.${domain}`);
  }
}
