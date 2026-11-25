export class InvalidPublishMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPublishMessageError';
  }
}

/** The commit message of a publish: 1 to 2,000 characters, no NUL, the first line (the subject) not blank. */
export class PublishMessage {
  static readonly MAX_LENGTH = 2000;

  private constructor(readonly value: string) {}

  /** Throws {@link InvalidPublishMessageError}. */
  static of(text: string): PublishMessage {
    if (text.length === 0 || text.length > PublishMessage.MAX_LENGTH) {
      throw new InvalidPublishMessageError(
        `Enter a message of 1 to ${PublishMessage.MAX_LENGTH} characters.`,
      );
    }
    if (text.includes('\0')) {
      throw new InvalidPublishMessageError('The message must not contain a NUL character.');
    }
    if (PublishMessage.firstLine(text).trim() === '') {
      throw new InvalidPublishMessageError(
        'The first line of the message is its subject: write one.',
      );
    }
    return new PublishMessage(text);
  }

  /** The first line: what a log shows. */
  get subject(): string {
    return PublishMessage.firstLine(this.value);
  }

  private static firstLine(text: string): string {
    const end = text.indexOf('\n');
    return end === -1 ? text : text.slice(0, end);
  }
}
