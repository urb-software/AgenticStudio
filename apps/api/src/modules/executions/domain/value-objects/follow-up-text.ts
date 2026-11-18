/** The text of a Follow-up: at most {@link FollowUpText.MAX_LENGTH} characters. */
export class FollowUpText {
  static readonly MAX_LENGTH = 10_000;

  private constructor(readonly value: string) {}

  /** Throws when the text is longer than the limit; a request schema refuses it earlier. */
  static of(text: string): FollowUpText {
    if (text.length > FollowUpText.MAX_LENGTH) {
      throw new Error('The Follow-up text is too long.');
    }
    return new FollowUpText(text);
  }
}
