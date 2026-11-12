// Redaction for server-side logs (security.md: no secrets in logs). Errors from
// drivers and HTTP clients often echo connection URLs or headers. Over-masking is
// acceptable; leaking any part of a credential is not.

/**
 * `scheme://<userinfo>@`: everything up to the last `@` of the token, so passwords
 * containing `@`, `/` or `:` are masked whole.
 */
const URL_USERINFO = /([a-z][a-z\d+.-]*:\/\/)\S*@/gi;

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
const SECRET_KEY = String.raw`[\w.-]*?(?:token|secret|password|passwd|pwd|api[_-]?key|session)[\w.-]*`;

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
  return text
    .replace(URL_USERINFO, '$1***@')
    .replace(ARGON2_HASH, '$1$***')
    .replace(COOKIE_HEADER, '$1***')
    .replace(AUTHORIZATION_VALUE, '$1 ***')
    .replace(QUOTED_SECRET, '$1$2***$2')
    .replace(UNQUOTED_SECRET, '$1***');
}
