import type { JobFailure } from '../../../../../platform/queue/job-queue.js';

export class CloneRepositoryHandler {
  onFailed(failure: JobFailure): void {
    void failure;
  }
}
