import {
  ENVIRONMENT_FILE_PATH_MAX_LENGTH,
  environmentFilePathProblem,
} from '@agentic-studio/contracts';

export class InvalidAgentDraftPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentDraftPathError';
  }
}

/** A path inside the definitions Repository, by the shared path rules: relative, no `..`, no `.git`, bounded. */
export class AgentDraftPath {
  static readonly MAX_LENGTH = ENVIRONMENT_FILE_PATH_MAX_LENGTH;

  private constructor(readonly value: string) {}

  /** Throws {@link InvalidAgentDraftPathError}. */
  static of(path: string): AgentDraftPath {
    if (path.length === 0) throw new InvalidAgentDraftPathError('Enter a path.');
    if (path.length > AgentDraftPath.MAX_LENGTH) {
      throw new InvalidAgentDraftPathError(
        `The path is longer than ${AgentDraftPath.MAX_LENGTH} characters.`,
      );
    }
    const problem = environmentFilePathProblem(path);
    if (problem !== null) throw new InvalidAgentDraftPathError(problem);
    return new AgentDraftPath(path);
  }
}
