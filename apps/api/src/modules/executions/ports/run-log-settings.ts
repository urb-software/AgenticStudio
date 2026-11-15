/** DI token of the {@link RunLogSettings}. */
export const RUN_LOG_SETTINGS = Symbol('RUN_LOG_SETTINGS');

/** Settings of Run logs (Issue #99). */
export interface RunLogSettings {
  /** The per-Run cap, in UTF-8 bytes of event text (`STUDIO_RUN_LOG_MAX_BYTES`, 8 MiB). */
  maxBytes: number;
  /** How often an idle live stream sends a keep-alive comment (15 s; tests shorten it). */
  keepAliveMs: number;
}
