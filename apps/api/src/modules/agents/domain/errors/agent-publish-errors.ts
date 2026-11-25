import type { ProblemCode } from '@agentic-studio/agent-definitions';

/** One problem the shared validation found in an agent folder the Draft touches. */
export interface PublishProblem {
  agent: string;
  code: ProblemCode;
  path: string;
  key: string | null;
  message: string;
}

/** The commit identity settings are not set: Studio will not commit as nobody. */
export class PublishNotConfiguredError extends Error {
  constructor() {
    super('The commit identity of the definitions Repository is not configured.');
    this.name = 'PublishNotConfiguredError';
  }
}

/** Another publish holds the lock. */
export class PublishRunningError extends Error {
  constructor() {
    super('Another publish is running.');
    this.name = 'PublishRunningError';
  }
}

/** The Draft changes no file, or its changes leave the tree as the base has it. */
export class NothingToPublishError extends Error {
  constructor() {
    super('The Draft changes nothing.');
    this.name = 'NothingToPublishError';
  }
}

/** The Repository holds another commit than the one the Draft began from, or the push was not a fast-forward. */
export class RepositoryMovedError extends Error {
  constructor() {
    super('The definitions Repository moved on since the Draft began.');
    this.name = 'RepositoryMovedError';
  }
}

/** The Git host refused the write. */
export class WriteRefusedError extends Error {
  constructor() {
    super('The Git host refused the write.');
    this.name = 'WriteRefusedError';
  }
}

/** The Draft would make agents that fail the shared validation: any problem blocks a publish. */
export class PublishProblemsError extends Error {
  constructor(readonly problems: readonly PublishProblem[]) {
    super('The Draft has problems that block a publish.');
    this.name = 'PublishProblemsError';
  }
}

/** The publish could not be done for a reason that is not the Operator's to fix in the Draft. */
export class PublishFailedError extends Error {
  constructor(readonly reason: 'repository_not_ready' | 'unsupported_platform' | 'failed') {
    super(`The publish failed: ${reason}.`);
    this.name = 'PublishFailedError';
  }
}
