import { checkWorkflowAgents } from '@agentic-studio/agent-definitions';
import { Injectable } from '@nestjs/common';
import type {
  NextPhase,
  PhaseOutcome,
  PlannedItem,
  WorkflowPlan,
  WorkflowPlans,
  WorkflowResolution,
} from '../../../executions/contracts/index.js';
import { WorkflowDefinitions } from '../../application/workflow-definitions.js';
import { WorkflowSequence } from '../../domain/value-objects/workflow-sequence.js';

/**
 * The driving adapter of {@link WorkflowPlans}: the Workflow of one name read at the last fetched
 * commit and judged against the agents its Phases name, and the order of the Phases of a plan.
 * Provider availability is the Run's start to judge, not this adapter.
 */
@Injectable()
export class DefinitionsWorkflowPlans implements WorkflowPlans {
  constructor(private readonly definitions: WorkflowDefinitions) {}

  async resolve(_projectId: string, name: string): Promise<WorkflowResolution> {
    const read = await this.definitions.read({ name });
    if (read.repository === null) return { status: 'unknown' };
    if (read.commit === null) {
      return {
        status: 'not_usable',
        reason: read.repository.note ?? 'The definitions Repository cannot be read now.',
      };
    }
    const flow = read.workflows[0];
    if (flow === undefined) return { status: 'unknown' };
    if (!flow.result.ok) {
      return { status: 'not_usable', reason: reasonOf(flow.result.problems) };
    }
    const { definition } = flow.result;
    const problems = checkWorkflowAgents(definition, flow.standings);
    if (problems.length > 0) return { status: 'not_usable', reason: reasonOf(problems) };
    const items = definition.sequence.map((item): PlannedItem => {
      if (item.kind === 'checkpoint') return { id: item.id, kind: 'checkpoint', text: item.text };
      return {
        id: item.id,
        kind: item.kind,
        agent: item.agent,
        ...(item.instructions === undefined ? {} : { instructions: item.instructions }),
      };
    });
    const plan: WorkflowPlan = { name: definition.name, commit: read.commit, items };
    return { status: 'resolved', plan };
  }

  next(plan: WorkflowPlan, position: number, outcome: PhaseOutcome): NextPhase {
    void outcome;
    return WorkflowSequence.of(plan.items).after(position);
  }
}

/** The shared validation's own wording: it quotes no value beyond a key, a name or a path. */
function reasonOf(problems: readonly { message: string }[]): string {
  const shown = problems.slice(0, 3).map((problem) => problem.message);
  const more =
    problems.length > shown.length ? ` (and ${problems.length - shown.length} more)` : '';
  return `The Workflow has problems: ${shown.join(' ')}${more}`;
}
