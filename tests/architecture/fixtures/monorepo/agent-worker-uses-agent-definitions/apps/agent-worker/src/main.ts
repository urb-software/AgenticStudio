import { validateAgentFiles } from '@agentic-studio/agent-definitions';

export const judge = (paths: string[]) =>
  validateAgentFiles(paths.map((path) => ({ path, kind: 'file', size: 0 })));
