export const validateAgentFiles = (entries: { path: string; kind: string; size: number }[]) =>
  entries.filter(() => false);
