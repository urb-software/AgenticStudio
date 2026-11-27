import { ApiError } from '../../../platform/api';

/** The problem types of the refusals of a Run start that name the agent (a 409 each). */
const AGENT_REFUSALS = {
  'urn:agentic-studio:problem:agent-unknown': {
    message: 'This agent no longer exists. The list of agents has been read again; pick another.',
    // The offered agents are out of date.
    refreshAgents: true,
    refreshProviders: false,
    showDetail: false,
  },
  'urn:agentic-studio:problem:agent-not-usable': {
    message:
      "This agent's definition has problems, so it cannot start a run. Fix it on the Agents page, or pick another agent.",
    refreshAgents: true,
    refreshProviders: false,
    showDetail: false,
  },
  'urn:agentic-studio:problem:workflow-unknown': {
    message: 'This Workflow no longer exists. The list has been read again; pick another.',
    refreshAgents: true,
    refreshProviders: false,
    showDetail: false,
  },
  'urn:agentic-studio:problem:workflow-not-usable': {
    message: 'This Workflow cannot start a run now.',
    refreshAgents: true,
    refreshProviders: true,
    // The server's detail names the reason (a Phase, a Provider, or what is not supported yet).
    showDetail: true,
  },
  'urn:agentic-studio:problem:provider-unavailable': {
    message:
      "This agent's Provider is switched off on the agent worker. Pick an agent of another Provider, or try again later.",
    refreshAgents: false,
    // The list says which Providers are off now, so the agent is disabled with its reason.
    refreshProviders: true,
    // The server's detail says which case it is (switched off, or no agent worker).
    showDetail: true,
  },
} as const;

export type StartRefusal = {
  /** Our wording for the refusal; the server's own detail is shown when this is absent. */
  message: string | undefined;
  /** Whether the agents the dialog offers are out of date and should be read again. */
  refreshAgents: boolean;
  /** Whether the Provider availability is out of date and should be read again. */
  refreshProviders: boolean;
  /** Whether the server's own detail adds to our message. */
  showDetail: boolean;
};

/** What a failed start says about the agent: one message per refusal reason. */
export function startRefusalOf(error: unknown): StartRefusal {
  const type = error instanceof ApiError && error.status === 409 ? error.problem?.type : undefined;
  const known =
    type === undefined ? undefined : AGENT_REFUSALS[type as keyof typeof AGENT_REFUSALS];
  return (
    known ?? {
      message: undefined,
      refreshAgents: false,
      refreshProviders: false,
      showDetail: false,
    }
  );
}
