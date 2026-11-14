import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The Repository in API responses (Issue #60 contract), shared by the connect, get-repository
 * and get-project features of this module (backend.md §2). Self-contained: it takes plain
 * shapes, not domain types. The objects are closed (unknown keys are stripped by the response
 * serializer), so no field can carry key material or unredacted Git output.
 */

/**
 * Later stories add states; clients must treat a value they do not know as "unavailable".
 */
export const repositoryStateSchema = z
  .enum(['connecting', 'ready', 'fetching', 'failed', 'disconnecting'])
  .meta({
    id: 'RepositoryState',
    description:
      'connecting: the first Clone is being made; ready: the Clone is up to date as of ' +
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
    'unknown',
  ])
  .meta({ id: 'RepositoryFailureCode', description: 'The fixed failure reason codes (Epic #55).' });

export const repositoryFailureSchema = z
  .object({
    code: repositoryFailureCodeSchema,
    /** Redacted Git output or a short fixed explanation ("Interrupted"); may be empty. */
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
     * Whether Studio holds a usable Clone: true when `ready` or `fetching`, and when `failed`
     * after a fetch that kept the Clone; false while `connecting` or `disconnecting`, and after
     * a failed connect or a fetch that had to remove the Clone (`size_limit`), which only
     * Retry repairs.
     */
    hasClone: z.boolean(),
    /** Commit id of the Integration branch in the Clone; present exactly when `hasClone`. */
    headSha: z.string().optional(),
    /** When the Clone was last brought up to date; present exactly when `hasClone`. */
    lastFetchedAt: z.iso.datetime().optional(),
    /** Present exactly when `failed`. */
    failure: repositoryFailureSchema.optional(),
  })
  .meta({ id: 'Repository' });

export class RepositoryResponseDto extends createZodDto(repositoryResponseSchema) {}

export type RepositorySummaryResponse = z.infer<typeof repositorySummarySchema>;
export type RepositoryResponse = z.infer<typeof repositoryResponseSchema>;

/** The plain shape the mappers take (a domain Repository fits it). */
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
}

export function toRepositorySummary(repository: RepositoryView): RepositorySummaryResponse {
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
  };
}
