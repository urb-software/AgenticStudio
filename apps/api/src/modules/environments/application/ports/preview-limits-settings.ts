export const PREVIEW_LIMITS = Symbol('PREVIEW_LIMITS');

/** The limits copied onto every Preview build when it is requested, already read from the configuration. */
export interface PreviewLimitsSettings {
  memoryMiB: number;
  cpuPercent: number;
  tasksMax: number;
  buildMinutes: number;
}
