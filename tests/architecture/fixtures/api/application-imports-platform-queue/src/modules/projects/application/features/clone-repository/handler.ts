import type { JobFailure } from '../../../../../platform/queue/job-queue.js';

export type CloneRepositoryInput = JobFailure;

export class CloneRepositoryHandler {
  execute(failure: CloneRepositoryInput): void {
    void failure;
  }
}
