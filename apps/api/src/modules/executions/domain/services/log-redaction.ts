/**
 * Redaction of Run event text before it is stored (Issue #99, security.md §3), the one place
 * it is written. **Best effort:** it catches the Run's known secret values, common token
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

function replaceKnownValues(text: string, knownSecrets: readonly string[]): string {
  const values = [...new Set(knownSecrets)]
    .filter((value) => value.length >= KNOWN_SECRET_MIN_LENGTH)
    // Longest first, so a value containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  return values.reduce((current, value) => current.split(value).join(REDACTED), text);
}

/**
 * `text` with the Run's `knownSecrets` (e.g. Environment file values, from #104), private key
 * blocks, credential-bearing URLs, Authorization/Bearer values and token-shaped strings
 * replaced by {@link REDACTED}.
 */
export function redactLogText(text: string, knownSecrets: readonly string[]): string {
  let redacted = replaceKnownValues(text, knownSecrets).replace(PRIVATE_KEY_BLOCK, REDACTED);
  redacted = maskUrlUserinfo(redacted)
    .replace(AUTHORIZATION_VALUE, `$1${REDACTED}`)
    .replace(BEARER_VALUE, `$1${REDACTED}`);
  return TOKEN_SHAPES.reduce((current, shape) => current.replace(shape, REDACTED), redacted);
}

/**
 * `value` (JSON data, e.g. a Run step's structured result) with every string in it redacted
 * by {@link redactLogText}; keys, numbers and the shape stay as they are.
 */
export function redactJsonStrings(value: unknown, knownSecrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactLogText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redactJsonStrings(item, knownSecrets));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactJsonStrings(item, knownSecrets)]),
    );
  }
  return value;
}
