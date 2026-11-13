import { redactSecrets } from '../../../../../platform/http/redact.js';
import type { GitFailureReason } from '../../../ports/repository-git.js';

/** Longest redacted Git output kept for a caller or a log line. */
export const MAX_DETAIL_LENGTH = 2_000;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/**
 * An absolute POSIX path that starts a token (after a line start, whitespace, a quote,
 * a bracket, `=` or `,`). URL paths are not matched: their `/` follows a host or `:`.
 */
const ABSOLUTE_PATH = /(^|[\s'"`(<[=,])\/(?!\/)[^\s'"`)>\]]*/gm;

/**
 * Redacts Git output before it is returned or logged (security.md §4): private keys,
 * credentials and secret-bearing URLs, and absolute paths (the data directory, temporary
 * directories, anything else on the host).
 */
export function redactGitOutput(text: string): string {
  const redacted = redactSecrets(text.replace(PRIVATE_KEY_BLOCK, '<private key>')).replace(
    ABSOLUTE_PATH,
    '$1<path>',
  );
  const trimmed = redacted.trim();
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `…${trimmed.slice(trimmed.length - MAX_DETAIL_LENGTH)}`
    : trimmed;
}

/** Git's messages (`LC_ALL=C`) mapped to the fixed reasons; the first match wins. */
const REASON_PATTERNS: [GitFailureReason, RegExp][] = [
  [
    'host_key_mismatch',
    /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|host key is known for .* you have requested strict checking|Host key for .* has changed/i,
  ],
  [
    'auth_failed',
    /Permission denied \(|Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP Basic: Access denied|requested URL returned error: (401|403)|Too many authentication failures/i,
  ],
  [
    'host_unreachable',
    /Could not resolve host|Could not resolve hostname|Connection refused|Connection timed out|Network is unreachable|No route to host|Failed to connect to|connect to host .* port \d+|Connection reset by peer|Connection closed by remote host|kex_exchange_identification|unable to access .*: (SSL|TLS|OpenSSL|gnutls)|server certificate verification failed/i,
  ],
  [
    'branch_not_found',
    /couldn't find remote ref|Remote branch .* not found|fatal: invalid refspec/i,
  ],
  [
    'repository_not_found',
    /Repository not found|does not appear to be a git repository|repository .* not found|requested URL returned error: 404/i,
  ],
];

/** Maps Git's (raw) stderr to a fixed failure reason. */
export function classifyGitFailure(stderr: string): GitFailureReason {
  for (const [reason, pattern] of REASON_PATTERNS) {
    if (pattern.test(stderr)) return reason;
  }
  return 'unknown';
}
