import { HostLiteral } from '../../../domain/value-objects/host-literal.js';
import { lookup } from 'node:dns/promises';
import {
  RemoteAddress,
  REFUSED_RANGE_REASON,
} from '../../../domain/value-objects/remote-address.js';
import {
  GitOperationError,
  GitRequestRejectedError,
} from '../../../application/ports/repository-git.js';

export type ResolveHost = (host: string) => Promise<string[]>;

export const systemResolveHost: ResolveHost = async (host) =>
  (await lookup(host, { all: true, order: 'verbatim' })).map((entry) => entry.address);

/**
 * The addresses Studio may connect to for `host` (security.md §4): an IP literal as itself, a
 * name as every address it resolves to. A disallowed address fails with `remote_not_allowed`,
 * an unresolvable host with `host_unreachable`; the caller pins the connection (DNS rebinding).
 */
export async function checkedAddresses(
  host: string,
  allowPrivate: boolean,
  resolve: ResolveHost,
): Promise<string[]> {
  const literal = HostLiteral.of(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  if (literal.kind === 'invalid') {
    throw new GitRequestRejectedError('Remote URL rejected: the host is not a valid host name.');
  }
  let addresses: string[];
  if (literal.kind === 'address') {
    addresses = [literal.address!];
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
    const range = RemoteAddress.of(address).refusedUnder(allowPrivate);
    if (!range) continue;
    const what = literal.kind === 'address' ? `${address} is` : `${host} resolves to ${address},`;
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
