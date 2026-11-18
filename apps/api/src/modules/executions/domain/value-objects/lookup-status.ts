export const LOOKUP_STATUSES = ['requested', 'claimed', 'done', 'failed'] as const;
export type LookupStatus = (typeof LOOKUP_STATUSES)[number];
