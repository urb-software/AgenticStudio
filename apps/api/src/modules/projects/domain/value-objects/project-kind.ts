/** What a Project is for: `code` (Runs, Preview) or `definitions` (the agent definitions Repository). */
export const PROJECT_KINDS = ['code', 'definitions'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === 'string' && (PROJECT_KINDS as readonly string[]).includes(value);
}
