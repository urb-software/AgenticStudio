export const REVIEW_COMMENT_SCOPES = ['since_last_result', 'unresolved'] as const;
export type ReviewCommentScope = (typeof REVIEW_COMMENT_SCOPES)[number];
