import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentResolution,
  AgentResolutions,
  ResolvedAgent,
} from '../../../../../agents/contracts/index.js';
import type {
  ProjectDefaultAgent,
  RunStartPoint,
  RunStartPoints,
} from '../../../../../projects/contracts/index.js';
import type {
  WorkflowPlan,
  WorkflowPlans,
  WorkflowResolution,
} from '../../../../contracts/index.js';
import {
  AgentNotChosenError,
  AgentNotUsableError,
  AgentProviderMismatchError,
  AgentUnknownError,
  DefinitionsProjectRunError,
  RepositoryNotReadyError,
  RunProjectNotFoundError,
  ProviderUnavailableError,
  WorkflowNotUsableError,
  WorkflowUnknownError,
} from '../../../../domain/errors/run-errors.js';
import { InMemoryRunRepository } from '../../../../domain/repositories/__tests__/in-memory-run-repository.js';
import type { WorkerStatusData } from '../../../../domain/value-objects/worker-status-data.js';
import type { WorkerStatusStore } from '../../../ports/worker-status-store.js';
import { FakeProjectKinds } from '../../../ports/__tests__/fake-project-kinds.js';
import { SEQUENTIAL_PLANS } from '../../../ports/__tests__/fake-workflow-plans.js';
import { FIRST_ITEM_NOT_A_PHASE, StartRunHandler } from '../handler.js';

const PROJECT = '3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e';
const HEAD = 'd'.repeat(40);
const REMOTE = 'git@github.com:acme/shop.git';
const NOW = new Date('2026-11-15T12:00:00.000Z');
const LEASE = { seconds: 60 };
const LIMITS = { stepMinutes: 45, maxSteps: 5, waitingDays: 3, maxTotalSteps: 20 };

const BUILT_IN = (provider: 'claude_code' | 'codex'): ResolvedAgent => ({
  name: `default-${provider.replace('_', '-')}`,
  source: 'built_in',
  commit: null,
  provider,
  model: 'default',
  instructions: '',
  skills: [] as string[],
});
const REVIEWER: ResolvedAgent = {
  name: 'reviewer',
  source: 'definitions',
  commit: 'c'.repeat(40),
  provider: 'claude_code',
  model: 'opus',
  instructions: 'Review carefully.',
  skills: [] as string[],
};

class InMemoryWorkerStatusStore implements WorkerStatusStore {
  private current: WorkerStatusData | undefined;
  record(status: WorkerStatusData) {
    this.current = status;
  }
  latest() {
    return this.current;
  }
  lastSeen() {
    return undefined;
  }
}

describe('StartRunHandler', () => {
  let runs: InMemoryRunRepository;
  let startPoint: RunStartPoint;
  let statuses: InMemoryWorkerStatusStore;
  const clock = { now: () => NOW };
  const kinds = new FakeProjectKinds();
  const known: Record<string, AgentResolution> = {};
  const resolved: string[] = [];
  const agents: AgentResolutions = {
    resolveForRun: (name) => {
      resolved.push(name);
      return Promise.resolve(known[name] ?? { status: 'unknown' });
    },
    resolveAt: (commit, name) => {
      resolvedAt.push(`${commit}:${name}`);
      return Promise.resolve(known[name] ?? { status: 'unknown' });
    },
  };
  const resolvedAt: string[] = [];
  const workflows: Record<string, WorkflowResolution> = {};
  const plans: WorkflowPlans = {
    ...SEQUENTIAL_PLANS,
    resolve: (_projectId, name) =>
      Promise.resolve(workflows[name] ?? ({ status: 'unknown' } as const)),
  };
  let projectDefault: ProjectDefaultAgent;
  const defaults = { forProject: () => Promise.resolve(projectDefault) };

  const startPoints: RunStartPoints = { forProject: () => Promise.resolve(startPoint) };
  const startWith = (request: {
    agent?: string;
    workflow?: string;
    provider?: 'claude_code' | 'codex';
  }) =>
    new StartRunHandler(
      kinds,
      runs,
      startPoints,
      agents,
      statuses,
      clock,
      LEASE,
      LIMITS,
      plans,
      defaults,
    ).execute({
      projectId: PROJECT,
      task: 'Fix the login bug',
      ...request,
    });
  const start = () => startWith({ provider: 'codex' });
  const workerReports = (codex: boolean, ageSeconds = 0) =>
    statuses.record({
      workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
      runner: 'cli',
      providers: { claude_code: true, codex },
      reportedAt: new Date(NOW.getTime() - ageSeconds * 1000),
    });

  beforeEach(() => {
    runs = new InMemoryRunRepository();
    startPoint = {
      status: 'ready',
      startCommit: HEAD,
      remoteUrl: REMOTE,
      integrationBranch: 'dev',
    };
    statuses = new InMemoryWorkerStatusStore();
    kinds.kind = 'code';
    workerReports(true);
    resolved.length = 0;
    resolvedAt.length = 0;
    projectDefault = { status: 'found', kind: 'code', agent: null, workflow: null };
    for (const key of Object.keys(workflows)) delete workflows[key];
    for (const key of Object.keys(known)) delete known[key];
    known['default-codex'] = { status: 'resolved', agent: BUILT_IN('codex') };
    known['default-claude-code'] = { status: 'resolved', agent: BUILT_IN('claude_code') };
    known['reviewer'] = { status: 'resolved', agent: REVIEWER };
    known['broken'] = { status: 'not_usable' };
    known['builder'] = { status: 'resolved', agent: { ...REVIEWER, name: 'builder' } };
    known['coder'] = {
      status: 'resolved',
      agent: { ...REVIEWER, name: 'coder', provider: 'codex', model: 'default' },
    };
  });

  it('copies the limits in force onto the Run', async () => {
    const { id } = await start();
    const run = (await runs.findById(id))!;

    expect(run.progress.limits).toEqual(LIMITS);
    expect(run).toMatchObject({
      lifecycle: { cancelRequestedAt: null, cancellation: null },
      progress: { waitingSince: null },
    });
  });

  it('queues a Run that starts from the current integration branch commit', async () => {
    const result = await start();
    const run = (await runs.findById(result.id))!;

    expect(result).toEqual({ id: run.id });
    expect(run).toMatchObject({
      projectId: PROJECT,
      provider: 'codex',
      task: 'Fix the login bug',
      startCommit: HEAD,
      remoteUrl: REMOTE,
      workingCopy: null,
      lifecycle: { state: 'queued', startedAt: null, finishedAt: null, failure: null },
      delivery: { integrationBranch: 'dev', state: null, pullRequest: null, requested: false },
    });
  });

  it('refuses the definitions Repository, starting nothing', async () => {
    kinds.kind = 'definitions';

    await expect(start()).rejects.toBeInstanceOf(DefinitionsProjectRunError);
    expect(runs.runs).toEqual([]);
  });

  it('rejects an unknown project', async () => {
    startPoint = { status: 'project_not_found' };

    await expect(start()).rejects.toBeInstanceOf(RunProjectNotFoundError);
    expect(runs.runs).toEqual([]);
  });

  it.each([
    ['no_repository', 'no_repository'],
    ['repository_not_ready', 'not_ready'],
  ] as const)('rejects a project whose start point is %s', async (status, reason) => {
    startPoint = { status };

    await expect(start()).rejects.toEqual(new RepositoryNotReadyError(reason));
    expect(runs.runs).toEqual([]);
  });

  describe('the agent', () => {
    it('means the Default agent of the Provider when a request names only the Provider', async () => {
      const { id } = await startWith({ provider: 'claude_code' });

      expect(resolved).toEqual(['default-claude-code']);
      expect((await runs.findById(id))!.agent.toData()).toEqual(BUILT_IN('claude_code'));
    });

    it('records the named agent as it stands now: name, source, commit, provider, model and instructions', async () => {
      const { id } = await startWith({ agent: 'reviewer' });
      const run = (await runs.findById(id))!;

      expect(run.agent.toData()).toEqual(REVIEWER);
      expect(run.provider).toBe('claude_code');
    });

    it('records the names of the skills the agent lists, in its order, and none for a built-in agent', async () => {
      known['reviewer'] = {
        status: 'resolved',
        agent: { ...REVIEWER, skills: ['notes', 'lint'] },
      };

      const named = (await runs.findById((await startWith({ agent: 'reviewer' })).id))!;
      const builtIn = (await runs.findById((await startWith({ provider: 'codex' })).id))!;

      expect(named.agent.toData().skills).toEqual(['notes', 'lint']);
      expect(builtIn.agent.toData().skills).toEqual([]);
    });

    it('takes the Provider from the agent and accepts the same Provider beside it', async () => {
      const { id } = await startWith({ agent: 'reviewer', provider: 'claude_code' });

      expect((await runs.findById(id))!.provider).toBe('claude_code');
    });

    it('refuses an agent of another Provider than the one named, starting nothing', async () => {
      await expect(startWith({ agent: 'reviewer', provider: 'codex' })).rejects.toEqual(
        new AgentProviderMismatchError('claude_code', 'codex'),
      );
      expect(runs.runs).toEqual([]);
    });

    it('refuses a request that names neither an agent nor a Provider, resolving nothing', async () => {
      await expect(startWith({})).rejects.toBeInstanceOf(AgentNotChosenError);
      expect(resolved).toEqual([]);
      expect(runs.runs).toEqual([]);
    });

    it('refuses an unknown agent and an agent that is not usable with distinct errors', async () => {
      await expect(startWith({ agent: 'nobody' })).rejects.toEqual(new AgentUnknownError('nobody'));
      await expect(startWith({ agent: 'broken' })).rejects.toEqual(
        new AgentNotUsableError('broken'),
      );
      expect(runs.runs).toEqual([]);
    });

    it('refuses an agent whose Provider is switched off, not the Provider of another agent', async () => {
      workerReports(false);

      await expect(startWith({ agent: 'default-codex' })).rejects.toEqual(
        new ProviderUnavailableError('codex', 'Switched off on the agent worker' as never),
      );
      expect((await startWith({ agent: 'reviewer' })).id).toBeTruthy();
    });

    it('checks the project and its Repository before it resolves the agent', async () => {
      startPoint = { status: 'no_repository' };

      await expect(startWith({ agent: 'nobody' })).rejects.toBeInstanceOf(RepositoryNotReadyError);
      expect(resolved).toEqual([]);
    });
  });

  describe('provider availability', () => {
    it.each([
      [
        'the worker reports it switched off',
        () => workerReports(false),
        'Switched off on the agent worker',
      ],
      [
        'no worker has reported',
        () => (statuses = new InMemoryWorkerStatusStore()),
        'No agent worker is connected',
      ],
      [
        'the last report is older than the lease',
        () => workerReports(true, 61),
        'No agent worker is connected',
      ],
    ])('refuses the provider when %s, starting nothing', async (_case, arrange, reason) => {
      arrange();

      await expect(start()).rejects.toEqual(new ProviderUnavailableError('codex', reason as never));
      expect(runs.runs).toEqual([]);
    });

    it('checks the project and its Repository first', async () => {
      statuses = new InMemoryWorkerStatusStore();
      startPoint = { status: 'project_not_found' };

      await expect(start()).rejects.toBeInstanceOf(RunProjectNotFoundError);
    });
  });

  describe('a Workflow', () => {
    const plan = (items: WorkflowPlan['items']): WorkflowResolution => ({
      status: 'resolved',
      plan: { name: 'flow', commit: 'f'.repeat(40), items },
    });
    const TWO_PHASES: WorkflowPlan['items'] = [
      { id: 'build', kind: 'work', agent: 'coder' },
      { id: 'polish', kind: 'work', agent: 'builder', instructions: 'Keep it small.' },
    ];

    beforeEach(() => {
      statuses.record({
        workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
        runner: 'cli',
        providers: { claude_code: true, codex: true },
        reportedAt: NOW,
      });
    });

    it('records the Workflow and one Phase per work item, all read at the Workflow commit', async () => {
      workflows['flow'] = plan(TWO_PHASES);

      const { id } = await startWith({ workflow: 'flow' });
      const run = (await runs.findById(id))!;

      expect(resolvedAt).toEqual([`${'f'.repeat(40)}:coder`, `${'f'.repeat(40)}:builder`]);
      expect(run.workflow?.toData()).toEqual({
        name: 'flow',
        commit: 'f'.repeat(40),
        items: TWO_PHASES,
        sendBacks: 2,
      });
      expect(run.phases.map((phase) => [phase.itemId, phase.agent.name, phase.state])).toEqual([
        ['build', 'coder', 'pending'],
        ['polish', 'builder', 'pending'],
      ]);
      expect(run.agent.name).toBe('coder');
      expect(run.provider).toBe('codex');
    });

    it('records the number of send-backs the Workflow names, and never more than two', async () => {
      workflows['flow'] = {
        status: 'resolved',
        plan: { name: 'flow', commit: 'f'.repeat(40), items: TWO_PHASES, sendBacks: 1 },
      };
      const lowered = (await runs.findById((await startWith({ workflow: 'flow' })).id))!;

      workflows['flow'] = {
        status: 'resolved',
        plan: { name: 'flow', commit: 'f'.repeat(40), items: TWO_PHASES, sendBacks: 7 },
      };
      const raised = (await runs.findById((await startWith({ workflow: 'flow' })).id))!;

      expect(lowered.workflow?.sendBacks).toBe(1);
      expect(raised.workflow?.sendBacks).toBe(2);
    });

    it('refuses an unknown Workflow, starting nothing', async () => {
      await expect(startWith({ workflow: 'nope' })).rejects.toEqual(
        new WorkflowUnknownError('nope'),
      );
      expect(runs.runs).toEqual([]);
    });

    it('refuses a Workflow that is not usable, with the reason', async () => {
      workflows['flow'] = { status: 'not_usable', reason: 'The Workflow has problems.' };

      await expect(startWith({ workflow: 'flow' })).rejects.toEqual(
        new WorkflowNotUsableError('The Workflow has problems.'),
      );
      expect(runs.runs).toEqual([]);
    });

    it('starts a Workflow with a review Phase, recording the Phase as a review', async () => {
      workflows['flow'] = plan([
        { id: 'build', kind: 'work', agent: 'coder' },
        { id: 'check', kind: 'review', agent: 'builder' },
      ]);

      const { id } = await startWith({ workflow: 'flow' });

      const run = runs.runs.find((candidate) => candidate.id === id)!;
      expect(
        (run.phases ?? []).map((phase) => [phase.itemId, phase.kind, phase.agent.name]),
      ).toEqual([
        ['build', 'work', 'coder'],
        ['check', 'review', 'builder'],
      ]);
    });

    it('starts a Workflow with a Checkpoint, which the Run records among its items', async () => {
      const items: WorkflowPlan['items'] = [
        { id: 'build', kind: 'work', agent: 'coder' },
        { id: 'wait', kind: 'checkpoint', text: 'Look at it.' },
        { id: 'polish', kind: 'work', agent: 'builder' },
      ];
      workflows['flow'] = plan(items);

      const run = (await runs.findById((await startWith({ workflow: 'flow' })).id))!;

      expect(run.workflow?.items).toEqual(items);
      expect(run.phases.map((phase) => phase.itemId)).toEqual(['build', 'polish']);
      expect(run.lifecycle.state).toBe('queued');
      expect(run.waiting).toBeNull();
    });

    it('refuses a Workflow whose first item is a Checkpoint, starting nothing', async () => {
      workflows['flow'] = plan([
        { id: 'wait', kind: 'checkpoint', text: 'Ready to start?' },
        { id: 'build', kind: 'work', agent: 'coder' },
      ]);

      await expect(startWith({ workflow: 'flow' })).rejects.toEqual(
        new WorkflowNotUsableError(FIRST_ITEM_NOT_A_PHASE),
      );
      expect(runs.runs).toEqual([]);
    });

    it('refuses a Workflow whose Phase names an agent that cannot be used at its commit', async () => {
      workflows['flow'] = plan([{ id: 'build', kind: 'work', agent: 'broken' }]);

      await expect(startWith({ workflow: 'flow' })).rejects.toBeInstanceOf(WorkflowNotUsableError);
      expect(runs.runs).toEqual([]);
    });

    it('refuses a Workflow that uses a Provider that is not available', async () => {
      workflows['flow'] = plan(TWO_PHASES);
      statuses.record({
        workerId: '6f1c2a4e-9b7d-4c3a-8e21-0d5f6a7b8c9d',
        runner: 'cli',
        providers: { claude_code: false, codex: true },
        reportedAt: NOW,
      });

      await expect(startWith({ workflow: 'flow' })).rejects.toBeInstanceOf(WorkflowNotUsableError);
      expect(runs.runs).toEqual([]);
    });

    it('starts the Project default when the request names neither an agent nor a Workflow', async () => {
      workflows['flow'] = plan(TWO_PHASES);
      projectDefault = { status: 'found', kind: 'code', agent: null, workflow: 'flow' };

      const { id } = await startWith({});

      expect((await runs.findById(id))!.workflow?.name).toBe('flow');
    });

    it('starts the Project default agent when it names one', async () => {
      projectDefault = { status: 'found', kind: 'code', agent: 'reviewer', workflow: null };

      const { id } = await startWith({});

      const run = (await runs.findById(id))!;
      expect(run.workflow).toBeNull();
      expect(run.agent.name).toBe('reviewer');
    });

    it('asks for a choice when there is no default', async () => {
      await expect(startWith({})).rejects.toBeInstanceOf(AgentNotChosenError);
    });

    it('starts a Run with an agent as before, without asking for a Workflow', async () => {
      const { id } = await startWith({ provider: 'codex' });

      const run = (await runs.findById(id))!;
      expect(run.workflow).toBeNull();
      expect(run.phases).toHaveLength(1);
      expect(resolvedAt).toEqual([]);
    });
  });
});
