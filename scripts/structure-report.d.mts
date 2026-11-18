export interface CommentFile {
  comment: number;
  code: number;
  ratio: number;
}
export function measureComments(root: string): Record<string, CommentFile>;
export function report(
  current: { comments?: Record<string, CommentFile> },
  base?: { comments?: Record<string, CommentFile> },
  top?: number,
): string;
