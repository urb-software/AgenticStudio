export const RUN_LOG_SETTINGS = Symbol('RUN_LOG_SETTINGS');

export interface RunLogSettings {
  /** UTF-8 bytes of event text, per Run. */
  maxBytes: number;
  /** Keep-alive interval of an idle stream; also how often a stream re-checks its session. */
  keepAliveMs: number;
  streamsPerSession: number;
  streamsTotal: number;
}
