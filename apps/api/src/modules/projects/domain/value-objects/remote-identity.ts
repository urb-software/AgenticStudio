export const SCHEME = /^([a-z][a-z\d+.-]*):\/\//i;
export const SCP_LIKE = /^([^@/:\s]+)@([^@/:\s]+):(.+)$/;

/**
 * The identity of a remote: host (lower-cased) plus repository path, without scheme, user, default
 * port, trailing `/` or `.git`, so the HTTPS, `ssh://` and scp-like forms of one repository are one
 * remote. A non-default port stays; the path keeps its case.
 */
export class RemoteIdentity {
  private static readonly SSH_SCHEMES = new Set(['ssh:', 'git+ssh:', 'ssh+git:']);

  private constructor(readonly value: string) {}

  /** `path` without leading and trailing slashes; a loop, so it stays linear on any input. */
  private static trimSlashes(path: string): string {
    let start = 0;
    let end = path.length;
    while (start < end && path[start] === '/') start += 1;
    while (end > start && path[end - 1] === '/') end -= 1;
    return path.slice(start, end);
  }

  private static normalizePath(path: string): string {
    const trimmed = RemoteIdentity.trimSlashes(path);
    return trimmed.toLowerCase().endsWith('.git')
      ? RemoteIdentity.trimSlashes(trimmed.slice(0, -4))
      : trimmed;
  }

  /** `null` when the input has no host and path. */
  static of(input: string): RemoteIdentity | null {
    const scp = SCHEME.test(input) ? null : SCP_LIKE.exec(input);
    if (scp) {
      const [, , host = '', path = ''] = scp;
      const normalized = RemoteIdentity.normalizePath(path);
      return host && normalized ? new RemoteIdentity(`${host.toLowerCase()}/${normalized}`) : null;
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    const path = RemoteIdentity.normalizePath(url.pathname);
    if (!path) return null;
    // A file URL (test-only fixture remotes) has no host: its identity is the path.
    if (url.protocol === 'file:') return new RemoteIdentity(`/${path}`);
    // The URL parser already drops https' default 443; ssh's default 22 is dropped here.
    const port =
      url.port === '' || (url.port === '22' && RemoteIdentity.SSH_SCHEMES.has(url.protocol))
        ? ''
        : `:${url.port}`;
    return new RemoteIdentity(`${url.hostname.toLowerCase()}${port}/${path}`);
  }
}
