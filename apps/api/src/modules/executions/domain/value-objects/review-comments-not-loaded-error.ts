/**
 * The comments chosen for a Follow-up are not all in the Run's loaded set (loaded again meanwhile,
 * sent already, or never loaded): the operator loads them again.
 */
export class ReviewCommentsNotLoadedError extends Error {
  constructor() {
    super('Some of the selected review comments are not loaded.');
    this.name = 'ReviewCommentsNotLoadedError';
  }
}
