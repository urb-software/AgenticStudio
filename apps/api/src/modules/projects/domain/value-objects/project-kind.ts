/**
 * What a Project is for: `code` (Runs, Preview) or `definitions` (the agent definitions
 * Repository).
 */
export const PROJECT_KIND_VALUES = ['code', 'definitions'] as const;
export type ProjectKind = (typeof PROJECT_KIND_VALUES)[number];

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === 'string' && (PROJECT_KIND_VALUES as readonly string[]).includes(value);
}
