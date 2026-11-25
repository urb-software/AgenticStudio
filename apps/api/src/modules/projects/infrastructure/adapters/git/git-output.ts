import { redactSecrets } from '../../../../../platform/http/redact.js';
import type { GitFailureReason } from '../../../application/ports/repository-git.js';

export const MAX_DETAIL_LENGTH = 2_000;

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
/**
 * An absolute POSIX path that starts a token (after a line start, whitespace, a quote,
 * a bracket, `=` or `,`). URL paths are not matched: their `/` follows a host or `:`.
 */
const ABSOLUTE_PATH = /(^|[\s'"`(<[=,])\/(?!\/)[^\s'"`)>\]]*/gm;
const FILE_URL_PATH = /\bfile:\/\/\/[^\s'"`)>\]]*/gi;

/**
 * Redacts Git output before it is returned or logged (security.md §4): private keys,
 * credentials and secret-bearing URLs, and absolute paths (the data directory, temporary
 * directories, anything else on the host).
 */
export function redactGitOutput(text: string): string {
  const redacted = redactSecrets(text.replace(PRIVATE_KEY_BLOCK, '<private key>'))
    .replace(FILE_URL_PATH, 'file://<path>')
    .replace(ABSOLUTE_PATH, '$1<path>');
  const trimmed = redacted.trim();
  return trimmed.length > MAX_DETAIL_LENGTH
    ? `…${trimmed.slice(trimmed.length - MAX_DETAIL_LENGTH)}`
    : trimmed;
}

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
  // Git runs with http.followRedirects=false: a redirect ends the request with its 3xx status.
  ['redirect_refused', /requested URL returned error: 3\d\d\b/i],
  [
    'branch_not_found',
    /couldn't find remote ref|Remote branch .* not found|fatal: invalid refspec/i,
  ],
  [
    'repository_not_found',
    /Repository not found|does not appear to be a git repository|repository .* not found|requested URL returned error: 404/i,
  ],
];

export function classifyGitFailure(stderr: string): GitFailureReason {
  for (const [reason, pattern] of REASON_PATTERNS) {
    if (pattern.test(stderr)) return reason;
  }
  return 'unknown';
}

/**
 * Whether a failed process ran into its memory bound (`RLIMIT_AS`): only its own diagnostic
 * lines count, never `remote:` text. A thread stack that cannot be mapped prints
 * `unable to create thread`; a process-count limit would too, and Studio sets none.
 */
const OUT_OF_MEMORY =
  /^(?:fatal|error): (?:Out of memory, malloc failed|mmap failed\b|unable to create thread|cannot create async thread)|^xmalloc: |: Cannot allocate memory$/m;

export function isOutOfMemory(stderr: string): boolean {
  const local = stderr
    .split('\n')
    .filter((line) => !line.startsWith('remote:'))
    .join('\n');
  return OUT_OF_MEMORY.test(local);
}

/** A ref the remote refused to move because it holds commits the push lacks (porcelain, then text). */
const PUSH_MOVED =
  /^!\t[^\t]*\t\[rejected\]|^ ?! \[rejected\]|Updates were rejected because the (?:remote|tip)|\((?:fetch first|non-fast-forward|stale info)\)/m;

/**
 * A push the host refused for want of write access: a read-only Deploy key, a protected branch, a
 * hook or a hidden ref declining it, or a key the host does not know. Matched on Git's and the
 * common hosts' wording; only the class is kept, never the text.
 */
const PUSH_WRITE_REFUSED = [
  /\[remote rejected\]/i,
  /marked as read only/i,
  /Write access to repository not granted/i,
  /Permission to .* denied/i,
  /not allowed to (?:push|upload)/i,
  /protected branch/i,
  /deny updating a hidden ref/i,
  /pre-receive hook declined/i,
  /insufficient permission/i,
  /User permission denied/i,
  /requested URL returned error: (?:401|403)/i,
  /Permission denied \(/i,
  /HTTP Basic: Access denied/i,
];

/**
 * What a failed `git push --porcelain` meant: `moved`, `write_refused`, or the reason
 * {@link classifyGitFailure} gives. The output is only classified, never returned or logged.
 */
export function classifyPushFailure(
  stdout: string,
  stderr: string,
): 'moved' | 'write_refused' | GitFailureReason {
  const output = `${stdout}\n${stderr}`;
  if (PUSH_MOVED.test(output)) return 'moved';
  if (PUSH_WRITE_REFUSED.some((pattern) => pattern.test(output))) return 'write_refused';
  return classifyGitFailure(stderr);
}
