import { z } from 'zod';

/** Why Studio cannot merge or close a Run's pull request. */
export const MERGE_UNAVAILABLE_REASONS = ['not_configured', 'unsupported_host'] as const;
export const mergeUnavailableReasonSchema = z.enum(MERGE_UNAVAILABLE_REASONS);
export type MergeUnavailableReason = z.infer<typeof mergeUnavailableReasonSchema>;

/** Whether Studio can merge or close a Run's pull request, answered without a Git host call. */
export const mergeAvailabilitySchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: mergeUnavailableReasonSchema }),
]);
export type MergeAvailability = z.infer<typeof mergeAvailabilitySchema>;
