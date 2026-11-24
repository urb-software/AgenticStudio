export const PREVIEW_RUNNING_LIMIT = Symbol('PREVIEW_RUNNING_LIMIT');

/** The most Previews that run at the same time, already read from the configuration. */
export interface PreviewRunningLimitSettings {
  maxRunning: number;
}
