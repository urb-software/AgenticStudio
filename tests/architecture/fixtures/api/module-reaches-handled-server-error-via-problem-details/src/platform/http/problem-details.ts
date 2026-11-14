export class ProblemException extends Error {
  constructor(readonly status: number) {
    super('problem');
  }
}

// Forbidden: the platform-only marker re-exported through the entry point modules use.
export { HandledServerErrorException } from './handled-server-error.js';
