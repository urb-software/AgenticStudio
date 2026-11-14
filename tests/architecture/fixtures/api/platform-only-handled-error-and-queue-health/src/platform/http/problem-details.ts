export class ProblemException extends Error {
  constructor(readonly status: number) {
    super('problem');
  }
}

export function serviceUnavailable(): ProblemException {
  return new ProblemException(503);
}
