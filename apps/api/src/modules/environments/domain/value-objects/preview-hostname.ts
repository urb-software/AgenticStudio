/** Where a Project's Preview is served: `preview-<first 12 hex of the project id>.<domain>`. */
export class PreviewHostname {
  static readonly ID_DIGITS = 12;

  private constructor(
    /** `preview-<12 hex>`: the one label the reverse proxy routes on (deploy/Caddyfile.preview). */
    readonly label: string,
    readonly value: string,
  ) {}

  /** `domain` is a validated DNS name; `projectId` a UUID. */
  static of(projectId: string, domain: string): PreviewHostname {
    const digits = projectId.replace(/-/g, '').slice(0, PreviewHostname.ID_DIGITS).toLowerCase();
    const label = `preview-${digits}`;
    return new PreviewHostname(label, `${label}.${domain}`);
  }
}
