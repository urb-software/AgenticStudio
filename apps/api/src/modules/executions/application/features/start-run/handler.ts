import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  AGENT_RESOLUTION,
  type AgentResolutions,
  type ResolvedAgent,
} from '../../../../agents/contracts/index.js';
import {
  PROJECT_DEFAULT_AGENTS,
  type ProjectDefaultAgents,
  PROJECT_KINDS,
  type ProjectKinds,
  RUN_START_POINTS,
  type RunStartPoints,
} from '../../../../projects/contracts/index.js';
import { type Provider } from '../../../domain/value-objects/provider.js';
import { WORKFLOW_PLANS, type WorkflowPlans } from '../../../contracts/index.js';
import {
  AgentNotChosenError,
  AgentNotUsableError,
  AgentUnknownError,
  DefinitionsProjectRunError,
  RepositoryNotReadyError,
  RunProjectNotFoundError,
  ProviderUnavailableError,
  WorkflowNotUsableError,
  WorkflowUnknownError,
} from '../../../domain/errors/run-errors.js';
import { Run } from '../../../domain/entities/run.js';
import { RunAgentChoice } from '../../../domain/value-objects/run-agent-choice.js';
import { Task } from '../../../domain/value-objects/task.js';
import { RUN_REPOSITORY, type RunRepository } from '../../../domain/repositories/run-repository.js';
import { PROVIDER_UNAVAILABLE_REASONS } from '../../../domain/value-objects/provider-unavailable-reason.js';
import { Lease } from '../../../domain/value-objects/lease.js';
import { WorkerPresence } from '../../../domain/value-objects/worker-presence.js';
import { CLOCK, type Clock } from '../../ports/clock.js';
import { RUN_LIMITS, type RunLimitsSetting } from '../../ports/run-limits.js';
import { WORKER_LEASE, type WorkerLease } from '../../ports/worker-lease.js';
import { WORKER_STATUS_STORE, type WorkerStatusStore } from '../../ports/worker-status-store.js';

/** Why a Workflow that starts with a Checkpoint cannot start a Run: there is nothing to look at. */
export const FIRST_ITEM_NOT_A_PHASE =
  'the first item of a Workflow must be a Phase, not a Checkpoint';

export interface StartRunInput {
  projectId: string;
  /** The agent by name; absent, the Default agent of `provider`. */
  agent?: string;
  /** A Workflow by name, in place of an agent. With neither, the Project's default. */
  workflow?: string;
  /** With an `agent`, the Provider the agent must belong to. */
  provider?: Provider;
  task: string;
}

export interface StartRunResult {
  id: string;
}

/**
 * Copies the agent, or the Workflow with each Phase's agent read at one commit, onto the Run. A
 * Provider known to be unavailable is refused (the worker's check stays authoritative). Throws the
 * refusals of `run-errors.ts`, {@link RunProjectNotFoundError} and `InvalidTaskError`.
 */
@Injectable()
export class StartRunHandler {
  constructor(
    @Inject(PROJECT_KINDS) private readonly kinds: ProjectKinds,
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_START_POINTS) private readonly startPoints: RunStartPoints,
    @Inject(AGENT_RESOLUTION) private readonly agents: AgentResolutions,
    @Inject(WORKER_STATUS_STORE) private readonly statuses: WorkerStatusStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WORKER_LEASE) private readonly lease: WorkerLease,
    @Inject(RUN_LIMITS) private readonly limits: RunLimitsSetting,
    @Inject(WORKFLOW_PLANS) private readonly plans: WorkflowPlans,
    @Inject(PROJECT_DEFAULT_AGENTS) private readonly defaults: ProjectDefaultAgents,
  ) {}

  async execute(input: StartRunInput): Promise<StartRunResult> {
    const requested = await this.requested(input);
    if ((await this.kinds.kindOf(input.projectId)) === 'definitions') {
      throw new DefinitionsProjectRunError();
    }
    const startPoint = await this.startPoints.forProject(input.projectId);
    switch (startPoint.status) {
      case 'project_not_found':
        throw new RunProjectNotFoundError();
      case 'no_repository':
        throw new RepositoryNotReadyError('no_repository');
      case 'repository_not_ready':
        throw new RepositoryNotReadyError('not_ready');
      case 'ready': {
        if (requested.workflow !== undefined) {
          return this.startWorkflow(input, requested.workflow, startPoint);
        }
        const choice = RunAgentChoice.of({
          ...(requested.agent === undefined ? {} : { agent: requested.agent }),
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        });
        const resolution = await this.agents.resolveForRun(choice.name);
        if (resolution.status !== 'resolved') {
          throw resolution.status === 'unknown'
            ? new AgentUnknownError(choice.name)
            : new AgentNotUsableError(choice.name);
        }
        const { agent } = resolution;
        choice.assertProvider(agent.provider);
        this.assertAvailable(agent.provider);
        return {
          id: (
            await this.runs.add(
              Run.start({
                id: randomUUID(),
                projectId: input.projectId,
                provider: agent.provider,
                agent,
                task: Task.of(input.task),
                startCommit: startPoint.startCommit,
                remoteUrl: startPoint.remoteUrl,
                integrationBranch: startPoint.integrationBranch,
                limits: { ...this.limits },
                now: this.clock.now(),
              }),
            )
          ).id,
        };
      }
    }
  }

  /**
   * What the request asks for: an agent or a Workflow by name, or, when it names neither an agent
   * nor a Provider, the Project's default. Throws {@link AgentNotChosenError} when there is none.
   */
  private async requested(input: StartRunInput): Promise<{ agent?: string; workflow?: string }> {
    if (input.workflow !== undefined) return { workflow: input.workflow };
    if (input.agent !== undefined || input.provider !== undefined) {
      return input.agent === undefined ? {} : { agent: input.agent };
    }
    const stored = await this.defaults.forProject(input.projectId);
    if (stored.status === 'found') {
      if (stored.workflow != null) return { workflow: stored.workflow };
      if (stored.agent !== null) return { agent: stored.agent };
    }
    throw new AgentNotChosenError();
  }

  private async startWorkflow(
    input: StartRunInput,
    name: string,
    startPoint: Extract<Awaited<ReturnType<RunStartPoints['forProject']>>, { status: 'ready' }>,
  ): Promise<StartRunResult> {
    const resolution = await this.plans.resolve(input.projectId, name);
    if (resolution.status === 'unknown') throw new WorkflowUnknownError(name);
    if (resolution.status === 'not_usable') throw new WorkflowNotUsableError(resolution.reason);
    const { plan } = resolution;
    if (this.plans.first(plan).kind !== 'phase') {
      throw new WorkflowNotUsableError(FIRST_ITEM_NOT_A_PHASE);
    }
    const phaseAgents: ResolvedAgent[] = [];
    for (const item of plan.items) {
      if (item.kind === 'checkpoint') continue;
      const resolved = await this.agents.resolveAt(plan.commit, item.agent);
      if (resolved.status !== 'resolved') {
        throw new WorkflowNotUsableError(
          `The Phase "${item.id}" names the agent "${item.agent}", which cannot be used at the ` +
            "Workflow's commit.",
        );
      }
      phaseAgents.push(resolved.agent);
    }
    for (const provider of new Set(phaseAgents.map((agent) => agent.provider))) {
      try {
        this.assertAvailable(provider);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          throw new WorkflowNotUsableError(
            `A Phase of the Workflow uses ${provider}, which is not available: ${error.reason}`,
          );
        }
        throw error;
      }
    }
    const first = phaseAgents[0]!;
    return {
      id: (
        await this.runs.add(
          Run.start({
            id: randomUUID(),
            projectId: input.projectId,
            provider: first.provider,
            agent: first,
            workflow: {
              record: { name: plan.name, commit: plan.commit, items: plan.items },
              phaseAgents,
            },
            task: Task.of(input.task),
            startCommit: startPoint.startCommit,
            remoteUrl: startPoint.remoteUrl,
            integrationBranch: startPoint.integrationBranch,
            limits: { ...this.limits },
            now: this.clock.now(),
          }),
        )
      ).id,
    };
  }

  private assertAvailable(provider: Provider): void {
    const availability = WorkerPresence.of(
      this.statuses.latest(),
      Lease.ofSeconds(this.lease.seconds),
    )
      .providerAvailability(this.clock.now())
      .find((candidate) => candidate.id === provider);
    if (!availability || availability.reason) {
      throw new ProviderUnavailableError(
        provider,
        availability?.reason ?? PROVIDER_UNAVAILABLE_REASONS.switchedOff,
      );
    }
  }
}
