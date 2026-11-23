export class InvalidPreviewPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPreviewPortError';
  }
}

/** The port of the service a Preview routes to. */
export class PreviewPort {
  static readonly MIN = 1;
  static readonly MAX = 65535;

  private constructor(readonly value: number) {}

  /** Throws {@link InvalidPreviewPortError}. */
  static of(port: number): PreviewPort {
    if (!Number.isInteger(port) || port < PreviewPort.MIN || port > PreviewPort.MAX) {
      throw new InvalidPreviewPortError(
        `The port is a whole number from ${PreviewPort.MIN} to ${PreviewPort.MAX}.`,
      );
    }
    return new PreviewPort(port);
  }
}
