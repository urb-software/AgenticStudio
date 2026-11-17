/**
 * Redaction of Run event text before it is stored (Issue #99, security.md §3), the one place
 * it is written, as a value object built from the Run's known secret values. **Best effort:** it catches the Run's known secret values, common token
 * shapes and credential-bearing URLs, never everything an agent might print. The log is
 * visible to the operator only. Over-masking is acceptable; every pattern runs in linear time.
 */

/** What a redacted value is replaced with. */
export const REDACTED = '••••••[redacted]';

/** Known values shorter than this are not redacted: replacing them would wreck the log. */
export const KNOWN_SECRET_MIN_LENGTH = 4;

const URL_SCHEME_SEPARATOR = /:\/\//g;
const WHITESPACE = /\s/g;

/**
 * `scheme://<userinfo>@host` → `scheme://••••••[redacted]@host`: everything up to the last
 * `@` of the whitespace-free token, so a password holding `@`, `/` or `:` is masked whole. A
 * scan, not a regex: each token is read once (no length cap, no backtracking).
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

/** A PEM private key block; one cut off before its END line is masked to the end of the text. */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

/** `Authorization: <scheme> <value>` (header or `-H` argument): the scheme and the value. */
const AUTHORIZATION_VALUE =
  /\b(Authorization\s{0,8}[:=]\s{0,8})(?:(?:Bearer|Basic|Token)\s+)?[^\s,;"']+/gi;

/** `Bearer <value>` anywhere else. */
const BEARER_VALUE = /\b(Bearer\s+)[^\s,;"']+/gi;

/** Token shapes of common services; each a fixed prefix and one character class. */
const TOKEN_SHAPES = [
  // GitHub personal, OAuth, user-to-server, server-to-server and refresh tokens.
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  // GitHub fine-grained personal access tokens.
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // `sk-…` API keys (e.g. OpenAI, Anthropic `sk-ant-…`).
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // JSON Web Tokens: header and payload are base64url JSON objects (`eyJ…`).
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
];

/** The free-text fields of a Run step's structured result (the worker protocol's shape). */
interface StepResultText {
  summary: string;
  question?: { text: string; options?: string[]; recommendation?: string };
  pullRequest?: { title: string; body: string };
  checks?: { name: string; detail?: string }[];
}

/**
 * What redacts a Run's text: built from the Run's known secret values (e.g. Environment file
 * values, from #104), it redacts text, a Run step's result, a failure and a Working copy report.
 */
export class LogRedaction {
  private readonly known: readonly string[];

  private constructor(known: readonly string[]) {
    this.known = known;
  }

  /** Redaction of the shapes alone, with no known secret values. */
  static readonly NONE = new LogRedaction([]);

  /** Redaction that also replaces the given known secret values. */
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

  /**
   * `text` with the known secret values, private key blocks, credential-bearing URLs,
   * Authorization/Bearer values and token-shaped strings replaced by {@link REDACTED}.
   */
  text(text: string): string {
    let redacted = this.replaceKnownValues(text).replace(PRIVATE_KEY_BLOCK, REDACTED);
    redacted = maskUrlUserinfo(redacted)
      .replace(AUTHORIZATION_VALUE, `$1${REDACTED}`)
      .replace(BEARER_VALUE, `$1${REDACTED}`);
    return TOKEN_SHAPES.reduce((current, shape) => current.replace(shape, REDACTED), redacted);
  }

  /**
   * A Run step's structured result (validated by the worker protocol) with its free-text fields
   * redacted by {@link LogRedaction.text}: the summary, the question (text, options,
   * recommendation: Issue #103), the pull request's title and
   * body, and each check's name and detail. The enum fields (`outcome`, each check's `result`)
   * are never touched, so a known value that equals one (e.g. an Environment file value `done`)
   * cannot make the stored result invalid (#104, from the #119 review).
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

  /** A failure the worker reported, its detail redacted like the log (Issue #104). */
  failure<T extends { detail: string }>(failure: T): T {
    return { ...failure, detail: this.text(failure.detail) };
  }

  /**
   * A Working copy report, its commit subjects (written by the agent) redacted like the log
   * (Issue #104); the commit ids and the branch name stay as they are.
   */
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
