/** A load of Review comments is under way already (Issue #146). */
export class ReviewCommentsLoadRunningError extends Error {
  constructor() {
    super('A load of the review comments is already running.');
    this.name = 'ReviewCommentsLoadRunningError';
  }
}
