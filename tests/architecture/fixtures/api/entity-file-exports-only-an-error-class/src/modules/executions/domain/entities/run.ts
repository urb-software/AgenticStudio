export class RunNotWaitingError extends Error {
  constructor() {
    super('The run is not waiting for an answer.');
  }
}
