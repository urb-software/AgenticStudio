import { WORKFLOW_DEFAULT_SEND_BACKS } from '@agentic-studio/agent-definitions';

/** One item of a Workflow as a Run records it: a Phase, or a Checkpoint kept for later. */
export type RunWorkflowItem =
  | {
      id: string;
      kind: 'work' | 'review';
      /** The name of the agent definition the Phase names. */
      agent: string;
      /** The item's own instructions for the Phase; absent when it sets none. */
      instructions?: string;
    }
  | { id: string; kind: 'checkpoint'; text: string };

/** What a Run records of its Workflow when it starts. */
export interface RunWorkflowData {
  name: string;
  /** The definitions Repository's commit the Workflow was read at. */
  commit: string;
  items: RunWorkflowItem[];
  /** The most send-backs per Run the Workflow allowed; absent means the default. */
  sendBacks?: number;
}

/**
 * The Workflow a Run started with, copied at start and never changed: a later edit or removal of
 * the definition does not reach the Run. The Phase texts are treated like the Task.
 */
export class RunWorkflow {
  readonly name: string;
  readonly commit: string;
  readonly items: readonly RunWorkflowItem[];
  /** The most send-backs this Run may use: the recorded number, never above the default of 2. */
  readonly sendBacks: number;

  private constructor(data: RunWorkflowData) {
    this.name = data.name;
    this.commit = data.commit;
    this.items = data.items.map((item) => ({ ...item }));
    const recorded = data.sendBacks;
    this.sendBacks =
      recorded === undefined || recorded === null || Number.isNaN(recorded)
        ? WORKFLOW_DEFAULT_SEND_BACKS
        : Math.min(Math.max(Math.trunc(recorded), 0), WORKFLOW_DEFAULT_SEND_BACKS);
  }

  /** Throws {@link TypeError} for a record the store should never hold. */
  static restore(data: RunWorkflowData): RunWorkflow {
    if (data.name === '' || data.commit === '') {
      throw new TypeError('A recorded Workflow has a name and a commit.');
    }
    const ids = new Set<string>();
    for (const item of data.items) {
      if (item.id === '' || ids.has(item.id)) {
        throw new TypeError('The items of a recorded Workflow have distinct ids.');
      }
      ids.add(item.id);
    }
    if (!data.items.some((item) => item.kind !== 'checkpoint')) {
      throw new TypeError('A recorded Workflow has at least one Phase.');
    }
    return new RunWorkflow(data);
  }

  /** The items that are Phases, in order: the position of a Phase is its index here. */
  get phases(): readonly Extract<RunWorkflowItem, { kind: 'work' | 'review' }>[] {
    return this.items.filter(
      (item): item is Extract<RunWorkflowItem, { kind: 'work' | 'review' }> =>
        item.kind !== 'checkpoint',
    );
  }

  toData(): RunWorkflowData {
    return {
      name: this.name,
      commit: this.commit,
      items: this.items.map((item) => ({ ...item })),
      sendBacks: this.sendBacks,
    };
  }
}
