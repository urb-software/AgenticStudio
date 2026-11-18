import { HostLiteral } from './host-literal.js';
import { RemoteIdentity, SCHEME, SCP_LIKE } from './remote-identity.js';
import { REFUSED_RANGE_REASON, RemoteAddress } from './remote-address.js';
import type { AddressPolicy } from './address-policy.js';
import type { SshRemote } from './ssh-remote.js';

export const REPOSITORY_URL_MAX_LENGTH = 2048;

const EXAMPLE = 'e.g. https://github.com/owner/repo.git';
const SSH_EXAMPLE = 'e.g. git@github.com:owner/repo.git';

export class InvalidRepositoryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepositoryUrlError';
  }
}

const LOCAL_PATH = /^(?:[/.~]|[a-z]:[\\/]|\\\\)/i;
// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f\\]/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;
const IPV6_LITERAL = /^\[[\da-f:.]+\]$/i;
/** An SSH login name: no option-like or shell-significant characters (the Git adapter's rule). */
const SSH_USER = /^[a-z_][a-z\d._-]{0,31}$/i;

export interface RepositoryUrlOptions {
  allowFileRemotes?: boolean;
  /**
   * Checks an IP-literal host against the address policy (a new URL at Connect). Without it no
   * address is checked (reading a stored URL); the Git adapter checks every address anyway.
   */
  addressPolicy?: AddressPolicy;
}

/**
 * The URL a Repository is connected with: public over anonymous HTTPS, or private over SSH with the
 * Deploy key (`user@host:path` or `ssh://`). `file://` only under the test-only fixture-remote setting.
 * The Git adapter validates it again before Git starts.
 */
export class RepositoryUrl {
  private constructor(
    readonly value: string,
    readonly identity: string,
    readonly ssh: SshRemote | null = null,
  ) {}

  /** `null` for a text that is no valid Repository URL. */
  static parseOrNull(raw: string): RepositoryUrl | null {
    try {
      return RepositoryUrl.parse(raw);
    } catch {
      return null;
    }
  }

  static parse(raw: string, options: RepositoryUrlOptions = {}): RepositoryUrl {
    const input = raw.trim();
    if (input.length === 0) RepositoryUrl.invalid('Enter the repository URL.');
    if (input.length > REPOSITORY_URL_MAX_LENGTH) {
      RepositoryUrl.invalid(`Use at most ${REPOSITORY_URL_MAX_LENGTH} characters.`);
    }
    if (UNSAFE_CHARACTERS.test(input)) {
      RepositoryUrl.invalid(`Enter the URL without spaces or backslashes, ${EXAMPLE}.`);
    }

    const scheme = SCHEME.exec(input)?.[1]?.toLowerCase();
    if (!scheme) {
      const scp = SCP_LIKE.exec(input);
      if (scp) {
        const ssh = RepositoryUrl.parseScpLike(input, scp, options.addressPolicy);
        return new RepositoryUrl(input, RemoteIdentity.of(input)!.value, ssh);
      }
      if (LOCAL_PATH.test(input)) {
        RepositoryUrl.invalid(`Local paths are not allowed. Enter an https:// URL, ${EXAMPLE}.`);
      }
      RepositoryUrl.invalid(`Enter a full https:// URL, ${EXAMPLE}.`);
    }
    if (scheme === 'git+ssh' || scheme === 'ssh+git') {
      RepositoryUrl.invalid(
        'Use git@host:owner/repo.git or ssh://git@host/owner/repo.git for SSH.',
      );
    }
    if (scheme === 'http') RepositoryUrl.invalid('Use https://. Plain http:// is not allowed.');
    if (scheme === 'git')
      RepositoryUrl.invalid('The git:// protocol is not allowed. Use https://.');
    if (scheme === 'file' && !options.allowFileRemotes) {
      RepositoryUrl.invalid(
        `Local paths and file:// URLs are not allowed. Enter an https:// URL, ${EXAMPLE}.`,
      );
    }
    if (scheme !== 'https' && scheme !== 'file' && scheme !== 'ssh') {
      RepositoryUrl.invalid(`Use an https:// URL, ${EXAMPLE}.`);
    }

    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return RepositoryUrl.invalid(`Enter a valid https:// URL, ${EXAMPLE}.`);
    }
    if (scheme === 'ssh') return RepositoryUrl.parseSshUrl(input, url, options.addressPolicy);
    if (url.username !== '' || url.password !== '' || /^[^/]*\/\/[^/]*@/.test(input)) {
      RepositoryUrl.invalid(
        'Remove the user name and password from the URL. Only public repositories are supported over HTTPS.',
      );
    }
    if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
      RepositoryUrl.invalid('Remove the query or fragment from the URL.');
    }
    if (scheme === 'https' && !HOSTNAME.test(url.hostname) && !IPV6_LITERAL.test(url.hostname)) {
      RepositoryUrl.invalid(`Enter a valid host name, ${EXAMPLE}.`);
    }
    if (scheme === 'https')
      RepositoryUrl.checkAddress(url.hostname, options.addressPolicy, EXAMPLE);
    if (scheme === 'file' && url.host !== '')
      RepositoryUrl.invalid('A file:// URL must not name a host.');
    if (url.pathname.split('/').some((segment) => segment.startsWith('-'))) {
      RepositoryUrl.invalid('A path segment must not start with "-".');
    }
    const identity = RemoteIdentity.of(input)?.value;
    if (!identity) RepositoryUrl.invalid(`Enter the full repository URL, ${EXAMPLE}.`);
    return new RepositoryUrl(input, identity);
  }

  private static parseSshUrl(
    input: string,
    url: URL,
    policy: AddressPolicy | undefined,
  ): RepositoryUrl {
    // The authority (between `//` and the next `/`) holds userinfo before its last `@`; a `:`
    // in the userinfo is a password, even an empty one. Index scans: linear on any input.
    const authorityStart = input.indexOf('//') + 2;
    const pathStart = input.indexOf('/', authorityStart);
    const authority = input.slice(authorityStart, pathStart === -1 ? undefined : pathStart);
    const userinfo = authority.slice(0, Math.max(0, authority.lastIndexOf('@')));
    if (url.password !== '' || userinfo.includes(':')) {
      RepositoryUrl.invalid(
        'Remove the password from the URL. Studio connects over SSH with a Deploy key.',
      );
    }
    if (url.username !== '' && !SSH_USER.test(decodeURIComponent(url.username))) {
      RepositoryUrl.invalid(`Enter a valid SSH user name, ${SSH_EXAMPLE}.`);
    }
    if (url.search !== '' || url.hash !== '' || input.includes('?') || input.includes('#')) {
      RepositoryUrl.invalid('Remove the query or fragment from the URL.');
    }
    if (!HOSTNAME.test(url.hostname))
      RepositoryUrl.invalid(`Enter a valid host name, ${SSH_EXAMPLE}.`);
    RepositoryUrl.checkAddress(url.hostname, policy, SSH_EXAMPLE);
    if (url.pathname.split('/').some((segment) => segment.startsWith('-'))) {
      RepositoryUrl.invalid('A path segment must not start with "-".');
    }
    const identity = RemoteIdentity.of(input)?.value;
    if (!identity) RepositoryUrl.invalid(`Enter the full repository URL, ${SSH_EXAMPLE}.`);
    return new RepositoryUrl(input, identity, {
      host: url.hostname.toLowerCase(),
      port: url.port === '' ? 22 : Number(url.port),
    });
  }

  private static invalid(message: string): never {
    throw new InvalidRepositoryUrlError(message);
  }

  /**
   * An IP-literal host (any numeric form the resolver accepts) must be allowed by the policy;
   * a numeric host that is no valid address is refused. Host names are checked by the Git
   * adapter once resolved.
   */
  private static checkAddress(
    host: string,
    policy: AddressPolicy | undefined,
    example: string,
  ): void {
    const literal = HostLiteral.of(host);
    if (literal.kind === 'invalid') RepositoryUrl.invalid(`Enter a valid host name, ${example}.`);
    if (!policy || literal.kind !== 'address') return;
    const range = RemoteAddress.of(literal.address!).refusedUnder(policy.allowPrivate);
    if (range) RepositoryUrl.invalid(`This address is not allowed: ${REFUSED_RANGE_REASON[range]}`);
  }

  private static parseScpLike(
    input: string,
    match: RegExpExecArray,
    policy: AddressPolicy | undefined,
  ): SshRemote {
    const [, user = '', host = '', path = ''] = match;
    if (!SSH_USER.test(user)) RepositoryUrl.invalid(`Enter a valid SSH user name, ${SSH_EXAMPLE}.`);
    if (!HOSTNAME.test(host)) RepositoryUrl.invalid(`Enter a valid host name, ${SSH_EXAMPLE}.`);
    RepositoryUrl.checkAddress(host, policy, SSH_EXAMPLE);
    if (path.split('/').some((segment) => segment.startsWith('-'))) {
      RepositoryUrl.invalid('A path segment must not start with "-".');
    }
    if (!RemoteIdentity.of(input))
      RepositoryUrl.invalid(`Enter the full repository URL, ${SSH_EXAMPLE}.`);
    return { host: host.toLowerCase(), port: 22 };
  }
}
