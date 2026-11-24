import { redactLogText } from '@agentic-studio/log-redaction';

/** Redacts a Preview operation's log line: the Environment file's values plus the common token shapes. */
export class PreviewLogRedaction {
  private constructor(private readonly known: readonly string[]) {}

  static of(knownSecrets: readonly string[]): PreviewLogRedaction {
    return new PreviewLogRedaction(knownSecrets);
  }

  text(text: string): string {
    return redactLogText(text, this.known);
  }
}
