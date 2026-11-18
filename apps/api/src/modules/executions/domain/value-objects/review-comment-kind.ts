export const REVIEW_COMMENT_KINDS = ['review', 'inline', 'conversation'] as const;
export type ReviewCommentKind = (typeof REVIEW_COMMENT_KINDS)[number];
