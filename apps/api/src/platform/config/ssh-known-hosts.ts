/**
 * The known_hosts vocabulary Studio uses for SSH host trust (Issue #62), shared by the
 * `STUDIO_SSH_KNOWN_HOSTS` configuration and the `projects` Git adapter, so both accept
 * exactly the same host keys and name hosts the same way. Plain functions over strings; no
 * key is stored or logged here.
 */

/** The host key types Studio accepts, in configuration and for a Git operation. */
export const SSH_HOST_KEY_TYPES = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-rsa',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
] as const;

/** One trusted host key: the known_hosts names of its hosts and the key. */
export interface SshKnownHost {
  /** Lower-case known_hosts names: `host`, or `[host]:port` for a port other than 22. */
  hosts: string[];
  /** `<type> <base64>`. */
  key: string;
}

const KEY_TYPES: ReadonlySet<string> = new Set(SSH_HOST_KEY_TYPES);
const BASE64 = /^[A-Za-z0-9+/]+={0,3}$/;
const HOST_NAME =
  /^(?=.{1,253}$)[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)*$/i;
const WITH_PORT = /^\[([^\]]+)\]:(\d{1,5})$/;

/** The known_hosts name of a host and port: `host` (lower case) for 22, `[host]:port` otherwise. */
export function knownHostName(host: string, port: number): string {
  const name = host.toLowerCase();
  return port === 22 ? name : `[${name}]:${port}`;
}

/**
 * A host key as `<type> <base64>` (a trailing comment is dropped), or `null` unless it is an
 * accepted type whose base64 blob names that same type.
 */
export function parseSshHostKey(value: string): string | null {
  const [type = '', data = ''] = value.trim().split(/\s+/);
  if (!KEY_TYPES.has(type) || !BASE64.test(data)) return null;
  const blob = Buffer.from(data, 'base64');
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : -1;
  if (
    typeLength < 0 ||
    typeLength + 4 > blob.length ||
    blob.subarray(4, 4 + typeLength).toString('latin1') !== type
  ) {
    return null;
  }
  return `${type} ${data}`;
}

/** A known_hosts host pattern in its normal form, or `null` when it is not a plain one. */
function parseHostPattern(pattern: string): string | null {
  const withPort = WITH_PORT.exec(pattern);
  const host = withPort ? withPort[1]! : pattern;
  const port = withPort ? Number(withPort[2]) : 22;
  if (!HOST_NAME.test(host) || port < 1 || port > 65535) return null;
  return knownHostName(host, port);
}

/** Why a known_hosts line is refused (fixed text, never the line), or the parsed entry. */
function parseLine(line: string): SshKnownHost | string {
  const [hostField = '', type = '', data = ''] = line.split(/\s+/);
  if (!data) return 'expected "<host>[,<host>…] <key type> <base64 key>"';
  if (hostField.startsWith('@')) {
    return 'markers such as @cert-authority or @revoked are not supported';
  }
  if (hostField.startsWith('|')) return 'hashed host names are not supported; use plain host names';
  if (/[*?!]/.test(hostField)) return 'wildcards and negated host names are not supported';
  const hosts = hostField.split(',').map(parseHostPattern);
  if (hosts.some((host) => host === null)) return 'each host must be a host name or [host]:port';
  if (!KEY_TYPES.has(type)) return 'unsupported key type';
  const key = parseSshHostKey(`${type} ${data}`);
  if (!key) return 'the key is not a valid base64 OpenSSH public key of the stated type';
  return { hosts: hosts as string[], key };
}

/**
 * Parses a `STUDIO_SSH_KNOWN_HOSTS` value: standard known_hosts lines, one per line (a
 * double-quoted multi-line `.env` value) or separated by a literal `\n`. Blank lines and `#`
 * comments are ignored. Each problem names its line number, never its content.
 */
export function parseKnownHosts(value: string): { entries: SshKnownHost[]; problems: string[] } {
  const entries: SshKnownHost[] = [];
  const problems: string[] = [];
  value.split(/\r?\n|\\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const parsed = parseLine(line);
    if (typeof parsed === 'string') problems.push(`line ${index + 1}: ${parsed}`);
    else entries.push(parsed);
  });
  return { entries, problems };
}
