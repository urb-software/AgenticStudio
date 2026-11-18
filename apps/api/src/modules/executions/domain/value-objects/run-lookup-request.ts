import type { LookupKind } from './lookup-kind.js';
import type { ReviewCommentsRequest } from './review-comments-request.js';

export interface RunLookupRequest {
  id: string;
  runId: string;
  kind: LookupKind;
  now: Date;
  review?: ReviewCommentsRequest;
}
