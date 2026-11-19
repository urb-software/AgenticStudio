import { HostLiteral } from '../../../domain/value-objects/host-literal.js';
import {
  InvalidRepositoryUrlError,
  RepositoryUrl,
} from '../../../domain/value-objects/repository-url.js';
import { GitRequestRejectedError } from '../../../application/ports/repository-git.js';

/** Transports a remote URL may use. Production allows exactly `ssh` and `https`. */
export type GitTransport = 'ssh' | 'https' | 'file';

export interface RemoteUrl {
  transport: GitTransport;
  url: string;
}

const SCP_LIKE = /^([^@/:\s]+)@([^@/:\s]+):(.+)$/;

function reject(reason: string): never {
  throw new GitRequestRejectedError(`Remote URL rejected: ${reason}.`);
}

const SSH_IPV6_HOST = /^(ssh:\/\/(?:[^/@[\]]+@)?)\[([\da-f:.]+)\](?=[:/]|$)/i;

/**
 * The domain refuses an IPv6 literal in an ssh:// URL, which the address policy covers when
 * the host is resolved. The literal is checked here and replaced by a placeholder host, so the
 * rest of the URL still goes through the domain; Git must read the same host back.
 */
function withoutIpv6Literal(input: string): string {
  const match = SSH_IPV6_HOST.exec(input);
  if (!match) return input;
  const literal = `[${match[2]}]`;
  if (HostLiteral.of(literal).kind === 'invalid') reject('the host is not a valid host name');
  let hostname: string;
  try {
    hostname = new URL(input).hostname;
  } catch {
    return reject('it is not a valid URL');
  }
  if (hostname !== new URL(`ssh://${literal}/`).hostname)
    reject('the host is not a valid host name');
  return input.replace(SSH_IPV6_HOST, '$1ipv6-literal.invalid');
}

/**
 * Validates a remote URL before Git starts (security.md §4): the shape is the domain's
 * {@link RepositoryUrl} rule; this adds the allowed transports and the exact input Git gets.
 */
export function parseRemoteUrl(
  input: string,
  allowedTransports: readonly GitTransport[],
): RemoteUrl {
  // The domain trims; Git must receive exactly what was stored.
  if (input !== input.trim()) reject('it has leading or trailing whitespace');

  let parsed: RepositoryUrl;
  try {
    parsed = RepositoryUrl.parse(withoutIpv6Literal(input), {
      allowFileRemotes: allowedTransports.includes('file'),
    });
  } catch (error) {
    if (error instanceof InvalidRepositoryUrlError) reject(error.message.replace(/\.$/, ''));
    throw error;
  }

  if (parsed.ssh) {
    if (!allowedTransports.includes('ssh')) reject('the ssh transport is not allowed');
    const isUrl = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
    return { transport: 'ssh', url: isUrl ? new URL(input).href : input };
  }
  const url = new URL(input);
  const transport = url.protocol.slice(0, -1);
  if (!isTransport(transport) || !allowedTransports.includes(transport)) {
    return reject(`the ${transport} transport is not allowed`);
  }
  return { transport, url: url.href };
}

export interface RemoteEndpoint {
  host: string;
  port: number;
}

/**
 * The host and port of an `ssh` remote already validated by {@link parseRemoteUrl}: port 22
 * for the scp-like form and for a URL without a port.
 */
export function sshEndpoint(remote: RemoteUrl): RemoteEndpoint {
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
export function remoteEndpoint(remote: RemoteUrl): RemoteEndpoint | null {
  if (remote.transport === 'ssh') return sshEndpoint(remote);
  if (remote.transport === 'file') return null;
  const url = new URL(remote.url);
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : 443 };
}

function isTransport(value: string): value is GitTransport {
  return value === 'ssh' || value === 'https' || value === 'file';
}
