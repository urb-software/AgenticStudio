import type { FollowUpRefusal } from './follow-up-refusal.js';

export type FollowUpEligibility = { allowed: true } | { allowed: false; reason: FollowUpRefusal };
