/**
 * Best effort (security.md §3): known secret values, common token shapes and credential-bearing
 * URLs, never everything an agent might print. Over-masking is acceptable; every scan runs in
 * linear time.
 */

export const REDACTED = '••••••[redacted]';

/** Replacing shorter known values would wreck the log. */
export const KNOWN_SECRET_MIN_LENGTH = 4;

const URL_SCHEME_SEPARATOR = /:\/\//g;
const WHITESPACE = /\s/g;

/**
 * Everything up to the last `@` of the whitespace-free token, so a password holding `@`, `/` or `:`
 * is masked whole. A scan, not a regex: linear time.
 */
function maskUrlUserinfo(text: string): string {
  let output = '';
  let copied = 0;
  URL_SCHEME_SEPARATOR.lastIndex = 0;
  for (
    let separator = URL_SCHEME_SEPARATOR.exec(text);
    separator;
    separator = URL_SCHEME_SEPARATOR.exec(text)
  ) {
    const start = separator.index + separator[0].length;
    WHITESPACE.lastIndex = start;
    const end = WHITESPACE.exec(text)?.index ?? text.length;
    const at = text.slice(start, end).lastIndexOf('@');
    if (at >= 0) {
      output += `${text.slice(copied, start)}${REDACTED}`;
      copied = start + at;
    }
    URL_SCHEME_SEPARATOR.lastIndex = end;
  }
  return output + text.slice(copied);
}

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

const AUTHORIZATION_VALUE =
  /\b(Authorization\s{0,8}[:=]\s{0,8})(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"']+/gi;

const BEARER_VALUE = /\b(Bearer\s+)[^\s,;"']+/gi;

const TOKEN_SHAPES = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

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

  private replaceKnownValues(text: string): string {
    const values = [...new Set(this.known)]
      .filter((value) => value.length >= KNOWN_SECRET_MIN_LENGTH)
      // Longest first, so a value containing another is replaced whole.
      .sort((a, b) => b.length - a.length);
    return values.reduce((current, value) => current.split(value).join(REDACTED), text);
  }

  text(text: string): string {
    let redacted = this.replaceKnownValues(text).replace(PRIVATE_KEY_BLOCK, REDACTED);
    redacted = maskUrlUserinfo(redacted)
      .replace(AUTHORIZATION_VALUE, `$1${REDACTED}`)
      .replace(BEARER_VALUE, `$1${REDACTED}`);
    return TOKEN_SHAPES.reduce((current, shape) => current.replace(shape, REDACTED), redacted);
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

  workingCopy<T extends { commits: { id: string; subject: string }[] }>(workingCopy: T): T {
    return {
      ...workingCopy,
      commits: workingCopy.commits.map((commit) => ({
        ...commit,
        subject: this.text(commit.subject),
      })),
    };
  }
}
