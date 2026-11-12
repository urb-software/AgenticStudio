// Redaction for server-side logs (security.md: no secrets in logs). Errors from
// drivers and HTTP clients often echo connection URLs or headers. Over-masking is
// acceptable; leaking any part of a credential is not.

/**
 * `scheme://<userinfo>@`: everything up to the last `@` of the token, so passwords
 * containing `@`, `/` or `:` are masked whole.
 */
const URL_USERINFO = /([a-z][a-z\d+.-]*:\/\/)\S*@/gi;

/** `token=…`, `password=…` etc. in query strings and key=value connection strings. */
const SECRET_PARAMETER =
  /(^|[?&;\s,])((?:access_token|token|password|secret|api_key|apikey)=)[^&#\s;,]*/gi;

/** `Authorization: Bearer …` / `Basic …` values. */
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[^\s,;]+/gi;

/** Masks credentials in free text before it is logged. */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_USERINFO, '$1***@')
    .replace(SECRET_PARAMETER, '$1$2***')
    .replace(AUTHORIZATION_VALUE, '$1 ***');
}
