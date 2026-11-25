import { MAX_FILE_BYTES } from '@agentic-studio/agent-definitions';
import {
  ENVIRONMENT_FILE_PATH_MAX_LENGTH,
  environmentFilePathProblem,
} from '@agentic-studio/contracts';
import { z } from 'zod';

/** A path the content route accepts: relative, inside the Repository, no `.git`, bounded. */
export const agentFilePathSchema = z
  .string()
  .min(1)
  .max(ENVIRONMENT_FILE_PATH_MAX_LENGTH)
  .superRefine((path, context) => {
    const problem = environmentFilePathProblem(path);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  });

/** Whether the content route would read this tree entry: a regular file, within limits, with a valid path. */
export function isOpenable(entry: { path: string; kind: string; size: number }): boolean {
  return (
    entry.kind === 'file' &&
    entry.size <= MAX_FILE_BYTES &&
    agentFilePathSchema.safeParse(entry.path).success
  );
}
