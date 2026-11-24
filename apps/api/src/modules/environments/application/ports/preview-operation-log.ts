import type { PreviewLogLine } from '../../domain/value-objects/preview-log-line.js';

export const PREVIEW_OPERATION_LOG = Symbol('PREVIEW_OPERATION_LOG');

/** The per-operation cap is applied atomically (`PreviewLogCap.plan`) against concurrent appends. */
export interface PreviewOperationLog {
  /**
   * The lines arrive already redacted, cut and in seq order: the port does not redact. A line
   * whose seq is already stored is ignored. Returns how many were stored and whether the cap is
   * reached, or `null` when the controller does not hold the operation.
   */
  append(
    operationId: string,
    controllerId: string,
    lines: readonly PreviewLogLine[],
    maxBytes: number,
  ): Promise<{ stored: number; truncated: boolean } | null>;

  /**
   * The stored lines with `seq` above `after`, in seq order, at most `limit`; `hasMore` says
   * whether lines remain beyond them. An operation with no lines gives an empty page.
   */
  page(
    operationId: string,
    after: number,
    limit: number,
  ): Promise<{ lines: PreviewLogLine[]; hasMore: boolean }>;
}
