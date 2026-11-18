export class ReviewCommentsLoadRunningError extends Error {
  constructor() {
    super('A load of the review comments is already running.');
    this.name = 'ReviewCommentsLoadRunningError';
  }
}
