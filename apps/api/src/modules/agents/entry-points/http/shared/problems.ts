import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../../platform/http/problem-details.js';

/** Problem `type` URIs of the agents API (RFC 9457). */
export const AGENTS_PROBLEM_TYPES = {
  agentNotFound: 'urn:agentic-studio:problem:agent-not-found',
  agentFileNotFound: 'urn:agentic-studio:problem:agent-file-not-found',
  agentCommitNotFound: 'urn:agentic-studio:problem:agent-commit-not-found',
  agentFilesUnreadable: 'urn:agentic-studio:problem:agent-files-unreadable',
} as const;

/** 404 for a name that is neither a built-in agent nor a folder at the last fetched commit. */
export function agentNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentNotFound,
    title: 'Agent not found',
    detail: 'No agent has this name.',
  });
}

/** 404 for a path that is no regular file at the commit, or when there is no commit to read. */
export function agentFileNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentFileNotFound,
    title: 'File not found',
    detail: 'The definitions Repository has no regular file at this path.',
  });
}

/** 404 for a commit the Clone of the definitions Repository does not hold. */
export function agentCommitNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentCommitNotFound,
    title: 'Commit not found',
    detail: 'The Clone of the definitions Repository does not hold this commit.',
  });
}

/** 503 when the Clone cannot be read here (the API is not on Linux, or Git failed). */
export function agentFilesUnreadable(): ProblemException {
  return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, {
    type: AGENTS_PROBLEM_TYPES.agentFilesUnreadable,
    title: 'Files cannot be read',
    detail: 'The Clone of the definitions Repository cannot be read now.',
  });
}
