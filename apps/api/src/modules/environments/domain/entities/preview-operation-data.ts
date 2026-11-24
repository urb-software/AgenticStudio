import type { PreviewLimitsData } from '../value-objects/preview-limits.js';
import type { PreviewOperationFailureData } from '../value-objects/preview-operation-failure.js';
import type { PreviewOperationKind } from '../value-objects/preview-operation-kind.js';
import type { PreviewOperationResultData } from '../value-objects/preview-operation-result.js';
import type { PreviewOperationStatus } from '../value-objects/preview-operation-status.js';

/** What a build was asked to build, copied from the Preview settings and the limits when requested. */
export interface PreviewBuildData {
  readonly commit: string;
  readonly composeFile: string;
  readonly service: string;
  readonly port: number;
  readonly limits: PreviewLimitsData;
}

/** What a Preview operation is restored from. */
export interface PreviewOperationData {
  readonly id: string;
  readonly projectId: string;
  readonly kind: PreviewOperationKind;
  readonly status: PreviewOperationStatus;
  /** Set exactly when the kind is `build`. */
  readonly build: PreviewBuildData | null;
  readonly requestedAt: Date;
  readonly claimedBy: string | null;
  readonly claimedAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly finishedAt: Date | null;
  /** Set exactly when the status is `failed`. */
  readonly failure: PreviewOperationFailureData | null;
  /** True only for a failed build whose rollback removed the running Preview, or a state check that found none. */
  readonly previewRemoved: boolean;
  readonly result: PreviewOperationResultData | null;
  /** The Environment file snapshot a build holds: its path and its secret store reference. */
  readonly environmentFile: { readonly path: string; readonly secretId: string } | null;
  /** UTF-8 bytes of log text stored, and whether the log reached its cap. */
  readonly log: { readonly bytes: number; readonly truncated: boolean };
}
