export class RunNotWaitingError extends Error {
  constructor(readonly state: string) {
    super('The run is not waiting for an answer.');
  }
}
