/**
 * The Deploy key's comment: `studio-<project name>`, the name reduced to letters, digits,
 * `.`, `_` and `-` (any other run becomes one `-`), at most 64 characters of it.
 */
export class DeployKeyComment {
  private static readonly NAME_MAX_LENGTH = 64;

  private constructor(readonly value: string) {}

  static of(projectName: string): DeployKeyComment {
    const safe = projectName
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, DeployKeyComment.NAME_MAX_LENGTH)
      .replace(/-+$/, '');
    return new DeployKeyComment(`studio-${safe || 'project'}`);
  }
}
