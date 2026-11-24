/** The Compose project name of a Project's Preview: `preview-` and the Project's id without dashes. */
export function composeProjectOf(projectId: string): string {
  return `preview-${projectId.replaceAll('-', '').toLowerCase()}`;
}
