export const MERGE_APPROVAL_RESULTS = ['pending', 'carried_out', 'not_carried_out'] as const;
export type MergeApprovalResult = (typeof MERGE_APPROVAL_RESULTS)[number];
