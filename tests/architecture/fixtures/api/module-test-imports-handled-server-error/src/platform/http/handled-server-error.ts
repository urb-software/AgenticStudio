export class HandledServerErrorException extends Error {
  readonly status = 503;
}
