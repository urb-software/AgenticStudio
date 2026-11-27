import { Injectable } from '@nestjs/common';
import { WorkflowsReader, type WorkflowsRead, type WorkflowView } from '../../workflows-reader.js';

export interface ReadWorkflowInput {
  /** Reads this Workflow only, wherever it sits among the folders. */
  name: string;
}

export interface ReadWorkflowResult {
  /** The commit the Workflow was read at; `null` when none was read. */
  commit: string | null;
  repository: WorkflowsRead['repository'];
  /** `null` when no folder has the name, or nothing could be read. */
  workflow: WorkflowView | null;
}

/** One Workflow with its items in order, reading its own folder and the agents it names. */
@Injectable()
export class ReadWorkflowHandler {
  constructor(private readonly reader: WorkflowsReader) {}

  async execute(input: ReadWorkflowInput): Promise<ReadWorkflowResult> {
    const { commit, repository, workflows } = await this.reader.read({ name: input.name });
    return { commit, repository, workflow: workflows[0] ?? null };
  }
}
