import type { PreviewCommit } from '../value-objects/preview-commit.js';
import type { PreviewComposeFile } from '../value-objects/preview-compose-file.js';
import type { PreviewLimits } from '../value-objects/preview-limits.js';
import type { PreviewOperationKind } from '../value-objects/preview-operation-kind.js';
import type { PreviewPort } from '../value-objects/preview-port.js';
import type { PreviewService } from '../value-objects/preview-service.js';

/** What a build request is made from. */
export interface PreviewBuildRequestFacts {
  id: string;
  projectId: string;
  commit: PreviewCommit;
  composeFile: PreviewComposeFile;
  service: PreviewService;
  port: PreviewPort;
  limits: PreviewLimits;
  now: Date;
}

/** What a request for stop, remove data or state is made from. */
export interface PreviewOtherRequestFacts {
  id: string;
  projectId: string;
  kind: Exclude<PreviewOperationKind, 'build'>;
  now: Date;
}
