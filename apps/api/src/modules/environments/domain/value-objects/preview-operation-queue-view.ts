import type { PreviewOperationStatus } from './preview-operation-status.js';

/** What the hand-out and the lost-controller rule need to know about one operation. */
export interface PreviewOperationQueueView {
  id: string;
  projectId: string;
  status: PreviewOperationStatus;
  requestedAt: Date;
  heartbeatAt: Date | null;
}
