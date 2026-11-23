export const PREVIEW_DOMAIN_SETTINGS = Symbol('PREVIEW_DOMAIN_SETTINGS');

/** The deployment's preview domain, already validated at start-up. */
export interface PreviewDomainSettings {
  /** The domain Previews are served under, or `null` while none is configured. */
  domain: string | null;
}
