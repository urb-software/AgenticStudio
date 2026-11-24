/** Where a Project's Preview is served: `preview-<first 12 hex of the project id>.<domain>`. */
export class PreviewHostname {
  static readonly ID_DIGITS = 12;

  private constructor(readonly value: string) {}

  /** The first DNS label: `preview-<first 12 hex of the project id>`. */
  get label(): string {
    return this.value.slice(0, this.value.indexOf('.'));
  }

  /** `domain` is a validated DNS name; `projectId` a UUID. */
  static of(projectId: string, domain: string): PreviewHostname {
    const digits = projectId.replace(/-/g, '').slice(0, PreviewHostname.ID_DIGITS).toLowerCase();
    return new PreviewHostname(`preview-${digits}.${domain}`);
  }
}
