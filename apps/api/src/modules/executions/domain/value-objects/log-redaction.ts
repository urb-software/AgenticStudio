import { KNOWN_SECRET_MIN_LENGTH, REDACTED, redactLogText } from '@agentic-studio/log-redaction';

export { KNOWN_SECRET_MIN_LENGTH, REDACTED };

interface StepResultText {
  summary: string;
  question?: { text: string; options?: string[]; recommendation?: string };
  pullRequest?: { title: string; body: string };
  checks?: { name: string; detail?: string }[];
}

export class LogRedaction {
  private readonly known: readonly string[];

  private constructor(known: readonly string[]) {
    this.known = known;
  }

  /** For the worker's own error text, which holds no known secret value. */
  static readonly NONE = new LogRedaction([]);

  static of(knownSecrets: readonly string[]): LogRedaction {
    return new LogRedaction(knownSecrets);
  }

  text(text: string): string {
    return redactLogText(text, this.known);
  }

  /**
   * The enum fields (`outcome`, each check's `result`) are never touched: a known value equal to
   * one would make the stored result invalid.
   */
  runStepResult<T extends StepResultText>(result: T): T {
    const redact = (text: string) => this.text(text);
    return {
      ...result,
      summary: redact(result.summary),
      ...(result.question === undefined
        ? {}
        : {
            question: {
              ...result.question,
              text: redact(result.question.text),
              ...(result.question.options === undefined
                ? {}
                : { options: result.question.options.map(redact) }),
              ...(result.question.recommendation === undefined
                ? {}
                : { recommendation: redact(result.question.recommendation) }),
            },
          }),
      ...(result.pullRequest === undefined
        ? {}
        : {
            pullRequest: {
              title: redact(result.pullRequest.title),
              body: redact(result.pullRequest.body),
            },
          }),
      ...(result.checks === undefined
        ? {}
        : {
            checks: result.checks.map((check) => ({
              ...check,
              name: redact(check.name),
              ...(check.detail === undefined ? {} : { detail: redact(check.detail) }),
            })),
          }),
    };
  }

  failure<T extends { detail: string }>(failure: T): T {
    return { ...failure, detail: this.text(failure.detail) };
  }

  workingCopy<T extends { commits: readonly { id: string; subject: string }[] }>(
    workingCopy: T,
  ): T {
    return {
      ...workingCopy,
      commits: workingCopy.commits.map((commit) => ({
        ...commit,
        subject: this.text(commit.subject),
      })),
    };
  }
}
