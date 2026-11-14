import { hostLiteral } from '../../../domain/value-objects/remote-address.js';
import { GitRequestRejectedError } from '../../../ports/repository-git.js';

/** Transports a remote URL may use. Production allows exactly `ssh` and `https`. */
export type GitTransport = 'ssh' | 'https' | 'file';

export interface RemoteUrl {
  transport: GitTransport;
  /** The URL as passed to Git: validated, never a local path or option-like value. */
  url: string;
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;
/** A bracketed IPv6 literal as the URL parser normalizes it. */
const IPV6_LITERAL = /^\[[\da-f:.]+\]$/i;
/** An SSH login name: no option-like or shell-significant characters. */
const SSH_USER = /^[a-z_][a-z\d._-]{0,31}$/i;
/** `user@host:path`, the scp-like SSH syntax (no slash before the colon). */
const SCP_LIKE = /^([^@/:\s]+)@([^@/:\s]+):(.+)$/;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f\\]/;

function reject(reason: string): never {
  throw new GitRequestRejectedError(`Remote URL rejected: ${reason}.`);
}

function checkHost(host: string): void {
  if (!HOSTNAME.test(host) && !IPV6_LITERAL.test(host)) {
    reject('the host is not a valid host name');
  }
  // A numeric host the resolver would read some other way than intended (Issue #69).
  if (hostLiteral(host).kind === 'invalid') reject('the host is not a valid host name');
}

function checkPath(path: string): void {
  if (path.length === 0 || path === '/') {
    reject('the repository path is missing');
  }
  if (path.startsWith('-') || path.includes('/-')) {
    reject('a path segment starts with "-"');
  }
}

/**
 * Validates a remote URL before Git starts (security.md §4): only the allowed transports,
 * no embedded credentials, no local paths, no option-like or control characters. The
 * scp-like SSH form (`git@host:owner/repo.git`) is accepted as `ssh`.
 */
export function parseRemoteUrl(
  input: string,
  allowedTransports: readonly GitTransport[],
): RemoteUrl {
  if (input.length === 0 || input.length > 2048) {
    reject('it is empty or too long');
  }
  if (UNSAFE_CHARACTERS.test(input)) {
    reject('it contains whitespace, control characters or a backslash');
  }
  if (input.startsWith('-')) {
    reject('it starts with "-"');
  }

  const scp = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? null : SCP_LIKE.exec(input);
  if (scp) {
    const [, user = '', host = '', path = ''] = scp;
    if (!allowedTransports.includes('ssh')) reject('the ssh transport is not allowed');
    if (!SSH_USER.test(user)) reject('the SSH user name is not valid');
    if (host.startsWith('[')) reject('the host is not a valid host name');
    checkHost(host);
    checkPath(path);
    return { transport: 'ssh', url: input };
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return reject('it is neither an ssh, https nor allowed URL');
  }
  const transport = url.protocol.slice(0, -1);
  if (!isTransport(transport) || !allowedTransports.includes(transport)) {
    return reject(`the ${transport} transport is not allowed`);
  }
  if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
    reject('it has a query or fragment');
  }

  if (transport === 'file') {
    if (url.host !== '' || url.username !== '' || url.password !== '') {
      reject('a file URL must not name a host');
    }
    checkPath(url.pathname);
    return { transport, url: url.href };
  }

  if (url.password !== '') {
    reject('it embeds credentials');
  }
  if (transport === 'https' && url.username !== '') {
    reject('it embeds credentials');
  }
  if (transport === 'ssh' && url.username !== '' && !SSH_USER.test(url.username)) {
    reject('the SSH user name is not valid');
  }
  checkHost(url.hostname);
  checkPath(url.pathname);
  return { transport, url: url.href };
}

/** Where an `ssh` remote's server listens. */
export interface SshEndpoint {
  /** Host name or IP address, without brackets. */
  host: string;
  port: number;
}

/**
 * The host and port of an `ssh` remote already validated by {@link parseRemoteUrl}: port 22
 * for the scp-like form and for a URL without a port.
 */
export function sshEndpoint(remote: RemoteUrl): SshEndpoint {
  if (remote.transport !== 'ssh') reject('only an ssh remote has an SSH endpoint');
  const scp = /^[a-z][a-z\d+.-]*:\/\//i.test(remote.url) ? null : SCP_LIKE.exec(remote.url);
  if (scp) return { host: scp[2]!, port: 22 };
  const url = new URL(remote.url);
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 22 };
}

/**
 * Where an `ssh` or `https` remote's server listens (port 443 for an https URL without a
 * port); `null` for a `file` remote, which names no host.
 */
export function remoteEndpoint(remote: RemoteUrl): SshEndpoint | null {
  if (remote.transport === 'ssh') return sshEndpoint(remote);
  if (remote.transport === 'file') return null;
  const url = new URL(remote.url);
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 443 };
}

function isTransport(value: string): value is GitTransport {
  return value === 'ssh' || value === 'https' || value === 'file';
}
