import { lookup } from 'node:dns/promises';
import {
  addressAllowed,
  classifyAddress,
  hostLiteral,
  REFUSED_RANGE_REASON,
} from '../../../domain/value-objects/remote-address.js';
import { GitOperationError, GitRequestRejectedError } from '../../../ports/repository-git.js';

/** Resolves a host name to every address the system resolver returns for it. */
export type ResolveHost = (host: string) => Promise<string[]>;

/** The system resolver (`getaddrinfo`, so `/etc/hosts` too), every address in its order. */
export const systemResolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, order: 'verbatim' })).map((entry) => entry.address);

/**
 * The addresses Studio may connect to for `host` (Issue #69, security.md §4): an IP literal
 * as itself (normalized from any numeric form), a host name as every address it resolves to.
 * Every address must be allowed by the policy, or the operation fails with
 * `remote_not_allowed` before Git starts; a host that does not resolve fails with
 * `host_unreachable`. The caller pins the connection to the returned addresses, so Git's own
 * lookup cannot answer differently (DNS rebinding).
 *
 * @param host a host name or IP address; an IPv6 address with or without brackets
 * @param resolve the lookup, raced by the caller against the operation's deadline
 */
export async function checkedAddresses(
  host: string,
  allowPrivate: boolean,
  resolve: ResolveHost,
): Promise<string[]> {
  const literal = hostLiteral(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  if (literal.kind === 'invalid') {
    throw new GitRequestRejectedError('Remote URL rejected: the host is not a valid host name.');
  }
  let addresses: string[];
  if (literal.kind === 'address') {
    addresses = [literal.address];
  } else {
    try {
      addresses = await resolve(host);
    } catch (error) {
      if (
        error instanceof GitOperationError ||
        (error as Error | undefined)?.name === 'AbortError'
      ) {
        throw error;
      }
      addresses = [];
    }
    if (addresses.length === 0) {
      throw new GitOperationError('host_unreachable', `Could not resolve host: ${host}`);
    }
  }
  for (const address of addresses) {
    if (addressAllowed(address, allowPrivate)) continue;
    const what = literal.kind === 'address' ? `${address} is` : `${host} resolves to ${address},`;
    const range = classifyAddress(address) === 'private' ? 'private' : 'blocked';
    const kind =
      range === 'private'
        ? 'a loopback or private address'
        : 'a link-local, metadata, multicast or reserved address';
    throw new GitOperationError(
      'remote_not_allowed',
      `${what} ${kind}. ${REFUSED_RANGE_REASON[range]}`,
    );
  }
  return addresses;
}
