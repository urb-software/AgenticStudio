export const PREVIEW_OPERATION_SETTINGS = Symbol('PREVIEW_OPERATION_SETTINGS');

/** How a claimed operation is leased, and how much of its log is kept. */
export interface PreviewOperationSettings {
  /** Seconds a claimed operation may go without a report before it fails as `controller_lost`. */
  leaseSeconds: number;
  /** UTF-8 bytes of log text kept per operation. */
  logMaxBytes: number;
}
