/** The labels that mark everything the controller created: it touches nothing without both. */
export const OWNER_LABEL = 'io.agentic-studio.owner';
export const OWNER_VALUE = 'environment-controller';
export const PROJECT_LABEL = 'io.agentic-studio.project';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

export const ownershipLabels = (projectId: string): Record<string, string> => ({
  [OWNER_LABEL]: OWNER_VALUE,
  [PROJECT_LABEL]: projectId,
});

/** Whether `labels` carry both ownership labels of this Project. */
export function isOwned(labels: Record<string, string> | null | undefined, projectId: string) {
  return labels?.[OWNER_LABEL] === OWNER_VALUE && labels[PROJECT_LABEL] === projectId;
}
