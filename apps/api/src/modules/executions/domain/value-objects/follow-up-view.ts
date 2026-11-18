import type { FollowUpEligibility } from './follow-up-eligibility.js';

export type FollowUpView = FollowUpEligibility & { openUntil?: Date; removalPending?: true };
