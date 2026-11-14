/** Longest accepted Repository URL, in characters (the Git adapter's own limit). */
export const REPOSITORY_URL_MAX_LENGTH = 2048;

const EXAMPLE = 'e.g. https://github.com/owner/repo.git';
const SSH_EXAMPLE = 'e.g. git@github.com:owner/repo.git';

/** The URL is not one a Repository can be connected with; `message` is the field error. */
export class InvalidRepositoryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepositoryUrlError';
  }
}

/** A scheme followed by `://`. */
const SCHEME = /^([a-z][a-z\d+.-]*):\/\//i;
/** `user@host:path`, the scp-like SSH syntax (no slash before the colon). */
const SCP_LIKE = /^([^@/:\s]+)@([^@/:\s]+):(.+)$/;
/** A local path: absolute, relative, home-relative, or a Windows drive or UNC path. */
const LOCAL_PATH = /^(?:[/.~]|[a-z]:[\\/]|\\\\)/i;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f\\]/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;
const IPV6_LITERAL = /^\[[\da-f:.]+\]$/i;
/** An SSH login name: no option-like or shell-significant characters (the Git adapter's rule). */
const SSH_USER = /^[a-z_][a-z\d._-]{0,31}$/i;

/** URL protocols of SSH remotes, whose default port is 22. */
const SSH_SCHEMES = new Set(['ssh:', 'git+ssh:', 'ssh+git:']);

function invalid(message: string): never {
  throw new InvalidRepositoryUrlError(message);
}

/** `path` without leading and trailing slashes; a loop, so it stays linear on any input. */
function trimSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === '/') start += 1;
  while (end > start && path[end - 1] === '/') end -= 1;
  return path.slice(start, end);
}

/** The repository path without leading or trailing slashes and without a trailing `.git`. */
function normalizePath(path: string): string {
  const trimmed = trimSlashes(path);
  return trimmed.toLowerCase().endsWith('.git') ? trimSlashes(trimmed.slice(0, -4)) : trimmed;
}

/**
 * The identity of a remote (Issue #60 clarification 6): host (lower-cased) plus repository
 * path, without the scheme, user, default port, trailing `/` or `.git`. So the `https://`,
 * `ssh://git@` and scp-like (`git@host:owner/repo.git`) forms of one repository are the same
 * remote. A non-default port stays (`host:8443/owner/repo`): two servers on one host are
 * different remotes. The path keeps its case. Returns `null` for input that names no host
 * and path.
 */
export function remoteIdentity(input: string): string | null {
  const scp = SCHEME.test(input) ? null : SCP_LIKE.exec(input);
  if (scp) {
    const [, , host = '', path = ''] = scp;
    const normalized = normalizePath(path);
    return host && normalized ? `${host.toLowerCase()}/${normalized}` : null;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const path = normalizePath(url.pathname);
  if (!path) return null;
  // A file URL (test-only fixture remotes) has no host: its identity is the path.
  if (url.protocol === 'file:') return `/${path}`;
  // The URL parser already drops https' default 443; ssh's default 22 is dropped here.
  const port =
    url.port === '' || (url.port === '22' && SSH_SCHEMES.has(url.protocol)) ? '' : `:${url.port}`;
  return `${url.hostname.toLowerCase()}${port}/${path}`;
}

/** What an SSH URL says about its Git host. */
export interface SshRemote {
  /**
   * The host as known_hosts names it: `host` (lower case) for port 22, `[host]:port`
   * otherwise. Trusted host keys are looked up by it.
   */
  hostName: string;
}

/** `host` for port 22, `[host]:port` otherwise: the known_hosts form. */
function knownHostName(host: string, port: string): string {
  const name = host.toLowerCase();
  return port === '' || port === '22' ? name : `[${name}]:${port}`;
}

function parseScpLike(input: string, match: RegExpExecArray): SshRemote {
  const [, user = '', host = '', path = ''] = match;
  if (!SSH_USER.test(user)) invalid(`Enter a valid SSH user name, ${SSH_EXAMPLE}.`);
  if (!HOSTNAME.test(host)) invalid(`Enter a valid host name, ${SSH_EXAMPLE}.`);
  if (path.split('/').some((segment) => segment.startsWith('-'))) {
    invalid('A path segment must not start with "-".');
  }
  if (!remoteIdentity(input)) invalid(`Enter the full repository URL, ${SSH_EXAMPLE}.`);
  return { hostName: knownHostName(host, '') };
}

/**
 * The URL a Repository is connected with: public over anonymous HTTPS (Issue #60), or
 * private over SSH with the project's Deploy key (Issue #62), as `user@host:path` or
 * `ssh://`. `file://` is accepted only under the test-only fixture-remote setting. The Git
 * adapter validates the URL again before Git starts; this is the operator-facing rule with
 * field-error messages.
 */
export class RepositoryUrl {
  private constructor(
    /** The URL as entered (trimmed); what Git is given and what the operator sees. */
    readonly value: string,
    /** {@link remoteIdentity}: what makes two URLs the same remote. */
    readonly identity: string,
    /** Set exactly for an SSH URL. */
    readonly ssh: SshRemote | null = null,
  ) {}

  static parse(raw: string, options: { allowFileRemotes?: boolean } = {}): RepositoryUrl {
    const input = raw.trim();
    if (input.length === 0) invalid('Enter the repository URL.');
    if (input.length > REPOSITORY_URL_MAX_LENGTH) {
      invalid(`Use at most ${REPOSITORY_URL_MAX_LENGTH} characters.`);
    }
    if (UNSAFE_CHARACTERS.test(input)) {
      invalid(`Enter the URL without spaces or backslashes, ${EXAMPLE}.`);
    }

    const scheme = SCHEME.exec(input)?.[1]?.toLowerCase();
    if (!scheme) {
      const scp = SCP_LIKE.exec(input);
      if (scp) return new RepositoryUrl(input, remoteIdentity(input)!, parseScpLike(input, scp));
      if (LOCAL_PATH.test(input)) {
        invalid(`Local paths are not allowed. Enter an https:// URL, ${EXAMPLE}.`);
      }
      invalid(`Enter a full https:// URL, ${EXAMPLE}.`);
    }
    if (scheme === 'git+ssh' || scheme === 'ssh+git') {
      invalid('Use git@host:owner/repo.git or ssh://git@host/owner/repo.git for SSH.');
    }
    if (scheme === 'http') invalid('Use https://. Plain http:// is not allowed.');
    if (scheme === 'git') invalid('The git:// protocol is not allowed. Use https://.');
    if (scheme === 'file' && !options.allowFileRemotes) {
      invalid(`Local paths and file:// URLs are not allowed. Enter an https:// URL, ${EXAMPLE}.`);
    }
    if (scheme !== 'https' && scheme !== 'file' && scheme !== 'ssh') {
      invalid(`Use an https:// URL, ${EXAMPLE}.`);
    }

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return invalid(`Enter a valid https:// URL, ${EXAMPLE}.`);
    }
    if (scheme === 'ssh') return RepositoryUrl.parseSshUrl(input, url);
    if (url.username !== '' || url.password !== '' || /^[^/]*\/\/[^/]*@/.test(input)) {
      invalid(
        'Remove the user name and password from the URL. Only public repositories are supported over HTTPS.',
      );
    }
    if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
      invalid('Remove the query or fragment from the URL.');
    }
    if (scheme === 'https' && !HOSTNAME.test(url.hostname) && !IPV6_LITERAL.test(url.hostname)) {
      invalid(`Enter a valid host name, ${EXAMPLE}.`);
    }
    if (scheme === 'file' && url.host !== '') invalid('A file:// URL must not name a host.');
    if (url.pathname.split('/').some((segment) => segment.startsWith('-'))) {
      invalid('A path segment must not start with "-".');
    }
    const identity = remoteIdentity(input);
    if (!identity) invalid(`Enter the full repository URL, ${EXAMPLE}.`);
    return new RepositoryUrl(input, identity);
  }

  /** An `ssh://[user@]host[:port]/path` URL: a login name, never a password. */
  private static parseSshUrl(input: string, url: URL): RepositoryUrl {
    // The authority (between `//` and the next `/`) holds userinfo before its last `@`; a `:`
    // in the userinfo is a password, even an empty one. Index scans: linear on any input.
    const authorityStart = input.indexOf('//') + 2;
    const pathStart = input.indexOf('/', authorityStart);
    const authority = input.slice(authorityStart, pathStart === -1 ? undefined : pathStart);
    const userinfo = authority.slice(0, Math.max(0, authority.lastIndexOf('@')));
    if (url.password !== '' || userinfo.includes(':')) {
      invalid('Remove the password from the URL. Studio connects over SSH with a Deploy key.');
    }
    if (url.username !== '' && !SSH_USER.test(decodeURIComponent(url.username))) {
      invalid(`Enter a valid SSH user name, ${SSH_EXAMPLE}.`);
    }
    if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
      invalid('Remove the query or fragment from the URL.');
    }
    if (!HOSTNAME.test(url.hostname)) invalid(`Enter a valid host name, ${SSH_EXAMPLE}.`);
    if (url.pathname.split('/').some((segment) => segment.startsWith('-'))) {
      invalid('A path segment must not start with "-".');
    }
    const identity = remoteIdentity(input);
    if (!identity) invalid(`Enter the full repository URL, ${SSH_EXAMPLE}.`);
    return new RepositoryUrl(input, identity, { hostName: knownHostName(url.hostname, url.port) });
  }
}

/**
 * The known_hosts name of a stored Repository URL's Git host (see {@link SshRemote}), or
 * `null` when the URL is not an SSH URL.
 */
export function sshHostName(url: string): string | null {
  try {
    return RepositoryUrl.parse(url).ssh?.hostName ?? null;
  } catch {
    return null;
  }
}
