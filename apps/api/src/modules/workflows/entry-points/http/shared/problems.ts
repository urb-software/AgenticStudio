import { HttpStatus } from '@nestjs/common';
import { ProblemException } from '../../../../../platform/http/problem-details.js';

/** Problem `type` URIs of the workflows API (RFC 9457). */
export const WORKFLOWS_PROBLEM_TYPES = {
  workflowNotFound: 'urn:agentic-studio:problem:workflow-not-found',
} as const;

/** 404 for a name that is no valid Workflow name or no Workflow folder at the last fetched commit. */
export function workflowNotFound(): ProblemException {
  return new ProblemException(HttpStatus.NOT_FOUND, {
    type: WORKFLOWS_PROBLEM_TYPES.workflowNotFound,
    title: 'Workflow not found',
    detail: 'No Workflow has this name.',
  });
}
