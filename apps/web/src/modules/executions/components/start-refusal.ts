import { ApiError } from '../../../platform/api';

/** The problem types of the refusals of a Run start that name the agent (a 409 each). */
const AGENT_REFUSALS = {
  'urn:agentic-studio:problem:agent-unknown': {
    message: 'This agent no longer exists. The list of agents has been read again; pick another.',
    // The offered agents are out of date.
    refreshAgents: true,
  },
  'urn:agentic-studio:problem:agent-not-usable': {
    message:
      "This agent's definition has problems, so it cannot start a run. Fix it on the Agents page, or pick another agent.",
    refreshAgents: true,
  },
  'urn:agentic-studio:problem:provider-unavailable': {
    message:
      "This agent's Provider is switched off on the agent worker, or no agent worker is connected. Pick an agent of another Provider, or try again later.",
    refreshAgents: false,
  },
} as const;

export type StartRefusal = {
  /** Our wording for the refusal; the server's own detail is shown when this is absent. */
  message: string | undefined;
  /** Whether the agents the dialog offers are out of date and should be read again. */
  refreshAgents: boolean;
};

/** What a failed start says about the agent: one message per refusal reason. */
export function startRefusalOf(error: unknown): StartRefusal {
  const type = error instanceof ApiError && error.status === 409 ? error.problem?.type : undefined;
  const known =
    type === undefined ? undefined : AGENT_REFUSALS[type as keyof typeof AGENT_REFUSALS];
  return known ?? { message: undefined, refreshAgents: false };
}
