import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The Repository in API responses. The objects are closed (unknown keys are stripped), so no
 * field can carry key material or unredacted Git output.
 */

/**
 * Clients must treat a value they do not know as "unavailable".
 */
export const repositoryStateSchema = z
  .enum([
    'awaiting_key',
    'awaiting_host_key',
    'connecting',
    'ready',
    'fetching',
    'failed',
    'disconnecting',
  ])
  .meta({
    id: 'RepositoryState',
    description:
      'awaiting_key: an SSH repository whose Deploy key (publicKey) the operator still has to ' +
      'add on the Git host, then verify; awaiting_host_key: the Git host is not trusted yet, and ' +
      'the operator has to confirm its host key fingerprint (hostKeyFingerprint) by verifying ' +
      'with acceptHostKeyFingerprint; connecting: the first Clone is being made; ready: the Clone is up to date as of ' +
      'lastFetchedAt; fetching: the Clone is being brought up to date; failed: the last ' +
      'operation failed (hasClone tells whether a usable Clone remains); disconnecting: the ' +
      'operator disconnected the repository and Studio is still removing its data (retried ' +
      'at start-up and on a repeated disconnect). Later stories add values; treat an unknown ' +
      'value as unavailable.',
  });

export const repositoryFailureCodeSchema = z
  .enum([
    'auth_failed',
    'host_unreachable',
    'host_key_mismatch',
    'repository_not_found',
    'branch_not_found',
    'timeout',
    'size_limit',
    'remote_not_allowed',
    'redirect_refused',
    'interrupted',
    'unknown',
  ])
  .meta({
    id: 'RepositoryFailureCode',
    description:
      'The fixed failure reason codes (Epic #55). remote_not_allowed: the remote host is or resolves ' +
      'to an address Studio does not connect to (Issue #69); redirect_refused: the remote answered ' +
      'with an HTTP redirect, which Studio does not follow; interrupted: the operation was cut off by ' +
      'a crash or a restart of Studio, not by the repository (Issue #72). Later versions may add values; treat an ' +
      'unknown value as a generic failure.',
  });

export const repositoryFailureSchema = z
  .object({
    code: repositoryFailureCodeSchema,
    /** Redacted Git output or a short fixed explanation; may be empty. */
    detail: z.string(),
    /** For `branch_not_found`: the remote's default branch, when the remote advertises one. */
    remoteDefaultBranch: z.string().optional(),
  })
  .meta({ id: 'RepositoryFailure' });

export const repositorySummarySchema = z
  .object({
    state: repositoryStateSchema,
    url: z.string(),
    integrationBranch: z.string(),
  })
  .meta({ id: 'RepositorySummary' });

export const repositoryResponseSchema = z
  .object({
    state: repositoryStateSchema,
    url: z.string(),
    integrationBranch: z.string(),
    /**
     * Whether Studio holds a usable Clone: true when `ready`, `fetching`, or `failed` after a
     * fetch that kept it; false while `connecting` or `disconnecting`, or after the Clone was removed.
     */
    hasClone: z.boolean(),
    /** Commit id of the Integration branch in the Clone; present exactly when `hasClone`. */
    headSha: z.string().optional(),
    /** When the Clone was last brought up to date; present exactly when `hasClone`. */
    lastFetchedAt: z.iso.datetime().optional(),
    /** Present exactly when `failed`. */
    failure: repositoryFailureSchema.optional(),
    /**
     * SSH only: the public half of the Deploy key, one OpenSSH line, to add on the Git host as
     * a read-only deploy key. The private half is never returned.
     */
    publicKey: z.string().optional(),
    /**
     * SSH only: the SHA256 fingerprint of the host key awaiting confirmation (`awaiting_host_key`),
     * otherwise of the pinned host key. Absent for a host trusted through configuration.
     */
    hostKeyFingerprint: z.string().optional(),
  })
  .meta({ id: 'Repository' });

export class RepositoryResponseDto extends createZodDto(repositoryResponseSchema) {}

export type RepositorySummaryResponse = z.infer<typeof repositorySummarySchema>;
export type RepositoryResponse = z.infer<typeof repositoryResponseSchema>;

export interface RepositoryView {
  state: RepositoryResponse['state'];
  url: string;
  integrationBranch: string;
  hasClone: boolean;
  headSha: string | null;
  lastFetchedAt: Date | null;
  failure: {
    code: z.infer<typeof repositoryFailureCodeSchema>;
    detail: string;
    remoteDefaultBranch: string | null;
  } | null;
  publicKey: string | null;
  hostKeyFingerprint: string | null;
}

export function toRepositorySummary(
  repository: Pick<RepositoryView, 'state' | 'url' | 'integrationBranch'>,
): RepositorySummaryResponse {
  return {
    state: repository.state,
    url: repository.url,
    integrationBranch: repository.integrationBranch,
  };
}

export function toRepositoryResponse(repository: RepositoryView): RepositoryResponse {
  const { failure } = repository;
  return {
    ...toRepositorySummary(repository),
    hasClone: repository.hasClone,
    ...(repository.headSha === null ? {} : { headSha: repository.headSha }),
    ...(repository.lastFetchedAt === null
      ? {}
      : { lastFetchedAt: repository.lastFetchedAt.toISOString() }),
    ...(failure === null
      ? {}
      : {
          failure: {
            code: failure.code,
            detail: failure.detail,
            ...(failure.remoteDefaultBranch === null
              ? {}
              : { remoteDefaultBranch: failure.remoteDefaultBranch }),
          },
        }),
    ...(repository.publicKey === null ? {} : { publicKey: repository.publicKey }),
    ...(repository.hostKeyFingerprint === null
      ? {}
      : { hostKeyFingerprint: repository.hostKeyFingerprint }),
  };
}
