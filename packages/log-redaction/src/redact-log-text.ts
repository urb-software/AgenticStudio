/**
 * Best effort (security.md §3): known secret values, common token shapes and credential-bearing
 * URLs, never everything a process might print. Over-masking is acceptable; every scan runs in
 * linear time.
 */

export const REDACTED = '••••••[redacted]';

/** Replacing shorter known values would wreck the log. */
export const KNOWN_SECRET_MIN_LENGTH = 4;

const URL_SCHEME_SEPARATOR = /:\/\//g;
const WHITESPACE = /\s/g;

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

/** `text` with every known secret value, token shape and URL credential replaced by {@link REDACTED}. */
export function redactLogText(text: string, knownSecrets: readonly string[]): string {
  let redacted = replaceKnownValues(text, knownSecrets).replace(PRIVATE_KEY_BLOCK, REDACTED);
  redacted = maskUrlUserinfo(redacted)
    .replace(AUTHORIZATION_VALUE, `$1${REDACTED}`)
    .replace(BEARER_VALUE, `$1${REDACTED}`);
  return TOKEN_SHAPES.reduce((current, shape) => current.replace(shape, REDACTED), redacted);
}

function replaceKnownValues(text: string, knownSecrets: readonly string[]): string {
  const values = [...new Set(knownSecrets)]
    .filter((value) => value.length >= KNOWN_SECRET_MIN_LENGTH)
    // Longest first, so a value containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  return values.reduce((current, value) => current.split(value).join(REDACTED), text);
}

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
