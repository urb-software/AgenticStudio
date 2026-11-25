import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../../platform/http/problem-details.js';

/** Problem `type` URIs of the agents API (RFC 9457). */
export const AGENTS_PROBLEM_TYPES = {
  agentNotFound: 'urn:agentic-studio:problem:agent-not-found',
} as const;

/** 404 for a name that is neither a built-in agent nor a folder at the last fetched commit. */
export function agentNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: AGENTS_PROBLEM_TYPES.agentNotFound,
    title: 'Agent not found',
    detail: 'No agent has this name.',
  });
}
