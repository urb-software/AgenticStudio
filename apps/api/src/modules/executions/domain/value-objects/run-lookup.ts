import type { ReviewComment, ReviewCommentsRequest } from './review-comments.js';

/**
 * Studio itself never reads the Git host: only an agent worker can answer, through the Agent account. The worker
 * protocol's lists are pinned to these by a test.
 */
export const LOOKUP_KINDS = [
  'pull_request_state',
  'failing_check_logs',
  'review_comments',
] as const;
export type LookupKind = (typeof LOOKUP_KINDS)[number];

export const LOOKUP_STATUSES = ['requested', 'claimed', 'done', 'failed'] as const;
export type LookupStatus = (typeof LOOKUP_STATUSES)[number];

export const LOOKUP_LEASE_SECONDS = 120;

export const LOOKUP_CLAIM_MAX = 5;

export const DAILY_REFRESH_AGE_HOURS = 24;

export const FINISHED_LOOKUPS_KEPT_DAYS = 7;

export const DAILY_REFRESH_BATCH = 200;

export const STORED_RETRY_DELAY_MAX_SECONDS = 60 * 60;

export type LookupRequestOutcome = 'requested' | 'open' | 'not_possible';

export type LookupAnswerOutcome = 'stored' | 'duplicate' | 'not_held';

export interface ReviewCommentsResult {
  comments: ReviewComment[];
  truncated: boolean;
}

export interface FailedCheckLog {
  name: string;
  url: string;
  logAvailable: boolean;
  excerpt?: string;
  note?: string;
}

export interface FailingCheckLogsResult {
  commit: string;
  checks: FailedCheckLog[];
}

export type LookupFailureCode = 'scope_mismatch' | 'rate_limited' | 'failed';

/** Redacted before it is stored. */
export class LookupFailure {
  private constructor(
    readonly code: LookupFailureCode,
    readonly error: string,
    readonly retryAfterSeconds: number | undefined,
  ) {}

  static of(input: {
    code: LookupFailureCode;
    error: string;
    retryAfterSeconds?: number | undefined;
  }): LookupFailure {
    return new LookupFailure(input.code, input.error, input.retryAfterSeconds);
  }

  get retryDelaySeconds(): number | null {
    if (this.code !== 'rate_limited') return null;
    return Math.min(Math.max(this.retryAfterSeconds ?? 60, 1), STORED_RETRY_DELAY_MAX_SECONDS);
  }
}

export interface RunLookupRequest {
  id: string;
  runId: string;
  kind: LookupKind;
  now: Date;
  review?: ReviewCommentsRequest;
}
