import {
  checkWorkflowAgents,
  type Problem,
  type Provider,
  type WorkflowProblemCode,
} from '@agentic-studio/agent-definitions';
import { Inject, Injectable } from '@nestjs/common';
import {
  PROVIDER_AVAILABILITIES,
  type ProviderAvailabilities,
} from '../../executions/contracts/index.js';
import type { RepositoryState } from '../../projects/contracts/index.js';
import { WorkflowUsability } from '../domain/value-objects/workflow-usability.js';
import { type JudgedWorkflow, WorkflowDefinitions } from './workflow-definitions.js';

export { MAX_LISTED_WORKFLOWS } from './workflow-definitions.js';
export type { WorkflowsReadInput } from './workflow-definitions.js';
import type { WorkflowsReadInput } from './workflow-definitions.js';

export type PhaseAgentState = 'valid' | 'invalid' | 'missing';

export type WorkflowItemView =
  | {
      kind: 'work' | 'review';
      id: string;
      agent: string;
      agentState: PhaseAgentState;
      /** `null` while the agent is not valid. */
      provider: Provider | null;
      /** True when the agent is valid and its Provider is available now. */
      usable: boolean;
    }
  | { kind: 'checkpoint'; id: string; text: string };

export interface WorkflowView {
  name: string;
  /** `null` for a Workflow whose entry file does not judge. */
  description: string | null;
  /** False while the folder or the agents its phases name have problems. */
  valid: boolean;
  /** Valid, and every Provider its phases use is available now. */
  usable: boolean;
  /** Why a valid Workflow cannot be chosen now (a Provider); `null` otherwise. */
  notUsableReason: string | null;
  problems: Problem<WorkflowProblemCode>[];
  /** The most send-backs per Run, the default applied; `null` for a Workflow without a sequence. */
  sendBacks: number | null;
  /** The phases and checkpoints in order; empty for a Workflow without a sequence. */
  items: WorkflowItemView[];
}

export interface WorkflowsRead {
  /** The commit the Workflows were read at; `null` when none were read. */
  commit: string | null;
  /** `null` when no definitions Repository is connected. */
  repository: { state: RepositoryState; note: string | null } | null;
  truncated: boolean;
  workflows: WorkflowView[];
}

/**
 * The Workflows as the operator sees them: the judged definitions, then the Providers available
 * now, which change over time. Shared by the list and the single Workflow.
 */
@Injectable()
export class WorkflowsReader {
  constructor(
    private readonly definitions: WorkflowDefinitions,
    @Inject(PROVIDER_AVAILABILITIES) private readonly providers: ProviderAvailabilities,
  ) {}

  async read(input: WorkflowsReadInput = {}): Promise<WorkflowsRead> {
    const read = await this.definitions.read(input);
    if (read.workflows.length === 0) return { ...read, workflows: [] };
    const providers = await this.providers.list();
    return { ...read, workflows: read.workflows.map((flow) => this.view(flow, providers)) };
  }

  private view(
    { name, result, standings }: JudgedWorkflow,
    providers: Awaited<ReturnType<ProviderAvailabilities['list']>>,
  ): WorkflowView {
    if (!result.ok) {
      return {
        name,
        description: null,
        valid: false,
        usable: false,
        notUsableReason: null,
        problems: result.problems,
        sendBacks: null,
        items: [],
      };
    }
    const { definition } = result;
    const problems = checkWorkflowAgents(definition, standings);
    const valid = problems.length === 0;
    const uses = definition.sequence.flatMap((item) => {
      if (item.kind === 'checkpoint') return [];
      const standing = standings.get(item.agent);
      const agentState: PhaseAgentState =
        standing === undefined ? 'missing' : standing.valid ? 'valid' : 'invalid';
      return [{ id: item.id, agentState, provider: standing?.valid ? standing.provider : null }];
    });
    const usability = WorkflowUsability.of(valid, uses, providers);
    const items = definition.sequence.map((item): WorkflowItemView => {
      if (item.kind === 'checkpoint') return { kind: 'checkpoint', id: item.id, text: item.text };
      const use = uses.find((candidate) => candidate.id === item.id);
      return {
        kind: item.kind,
        id: item.id,
        agent: item.agent,
        agentState: use?.agentState ?? 'missing',
        provider: use?.provider ?? null,
        usable: usability.isPhaseUsable(item.id),
      };
    });
    return {
      name: definition.name,
      description: definition.description,
      valid,
      usable: usability.usable,
      notUsableReason: usability.reason,
      problems,
      sendBacks: definition.sendBacks,
      items,
    };
  }
}
