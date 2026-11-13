// Redaction for server-side logs (security.md: no secrets in logs). Errors from
// drivers and HTTP clients often echo connection URLs or headers. Over-masking is
// acceptable; leaking any part of a credential is not.

/**
 * The `://` after a URL scheme. The scheme itself is not matched: a boundary or length
 * rule on it let `1postgres://`, `.postgres://` or a 40-character scheme through
 * unmasked (#33 review), and over-masking is acceptable.
 */
const URL_SCHEME_SEPARATOR = /:\/\//g;
const WHITESPACE = /\s/g;

/**
 * `scheme://<userinfo>@` → `scheme://***@`: everything up to the last `@` of the
 * whitespace-free token, so passwords containing `@`, `/` or `:` are masked whole, at
 * any length. A regex cannot do this without either a length cap (which leaks longer
 * secrets, #24) or quadratic backtracking, so this scans instead: each token is read
 * once and scanning resumes after it, so the whole pass is linear in the input.
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
      output += `${text.slice(copied, start)}***`;
      copied = start + at;
    }
    // Any later `://` in this token lies inside the masked userinfo or after its last
    // `@`, where there is nothing left to mask.
    URL_SCHEME_SEPARATOR.lastIndex = end;
  }
  return output + text.slice(copied);
}

/** Argon2 PHC strings (`$argon2id$v=19$m=…$salt$digest`): parameters, salt and digest. */
const ARGON2_HASH = /(\$argon2(?:id|i|d))\$[^\s"';]+/gi;

/** `Cookie:` / `Set-Cookie:` headers carry session IDs: mask the whole value. */
const COOKIE_HEADER = /\b((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi;

/** `Authorization: Bearer …` / `Basic …` / `Token …` values. */
const AUTHORIZATION_VALUE = /\b(Bearer|Basic|Token)\s+[^\s,;]+/gi;

/**
 * A secret-looking key, including prefixed and abbreviated names (`refresh_token`,
 * `client_secret`, `X-Api-Key`, `pwd`) and session cookie names (`studio_session`).
 */
// Bounded repetition keeps matching linear: unbounded `[\w.-]*` around the keyword
// backtracks quadratically on long runs such as `tokentoken…` (ReDoS).
const SECRET_KEY = String.raw`[\w.-]{0,64}?(?:token|secret|password|passwd|pwd|api[_-]?key|session)[\w.-]{0,64}`;

/** Quoted values: `{"password":"x"}`, `passwd: 'x'`, `"client_secret" = "x"`. */
const QUOTED_SECRET = new RegExp(
  String.raw`(?<![\w-])(["']?${SECRET_KEY}["']?\s*[:=]\s*)(["'])(?:\\.|(?!\2)[^\\])*\2`,
  'gi',
);

/**
 * Unquoted values: query strings and fragments (`?token=x`, `#access_token=x`),
 * connection strings (`password=x`), colon forms and headers (`X-Api-Key: x`).
 */
const UNQUOTED_SECRET = new RegExp(
  String.raw`(?<![\w-])(${SECRET_KEY}\s*[:=]\s*)(?!\*\*\*)[^\s&#;,"'}]+`,
  'gi',
);

/** Masks credentials in free text before it is logged. */
export function redactSecrets(text: string): string {
  return maskUrlUserinfo(text)
    .replace(ARGON2_HASH, '$1$***')
    .replace(COOKIE_HEADER, '$1***')
    .replace(AUTHORIZATION_VALUE, '$1 ***')
    .replace(QUOTED_SECRET, '$1$2***$2')
    .replace(UNQUOTED_SECRET, '$1***');
}
