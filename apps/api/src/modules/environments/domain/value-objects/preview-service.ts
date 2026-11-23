export class InvalidPreviewServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPreviewServiceError';
  }
}

/** The Compose service a Preview routes to, by the Compose service-name rule. */
export class PreviewService {
  static readonly MAX_LENGTH = 63;
  static readonly PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

  private constructor(readonly value: string) {}

  /** Throws {@link InvalidPreviewServiceError}. */
  static of(name: string): PreviewService {
    if (name.length === 0) throw new InvalidPreviewServiceError('Enter the service name.');
    if (name.length > PreviewService.MAX_LENGTH) {
      throw new InvalidPreviewServiceError(
        `The service name is longer than ${PreviewService.MAX_LENGTH} characters.`,
      );
    }
    if (!PreviewService.PATTERN.test(name)) {
      throw new InvalidPreviewServiceError(
        'A service name starts with a letter or digit and holds letters, digits, ".", "_" and "-".',
      );
    }
    return new PreviewService(name);
  }
}
