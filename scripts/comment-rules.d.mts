export const MAX_COMMENT_LINES: number;

export interface CommentBlock {
  startLine: number;
  endLine: number;
  /** Lines of text counted for rule 14. */
  lines: number;
  texts: string[];
  trailing: boolean;
}

export interface CommentViolation {
  rule: 'comment-no-issue-reference' | 'comment-max-lines' | 'comment-long-needs-reason';
  line: number;
  message: string;
}

export function inScope(path: string): boolean;
export function listSourceFiles(root: string): string[];
export function analyse(
  text: string,
  fileName?: string,
): { blocks: CommentBlock[]; codeLines: number };
export function checkText(text: string, fileName?: string): CommentViolation[];
export function checkTree(root: string): (CommentViolation & { file: string })[];
export function countLines(
  text: string,
  fileName?: string,
): { comment: number; code: number } | undefined;
export function longComments(root: string): { file: string; line: number; reason: string }[];
