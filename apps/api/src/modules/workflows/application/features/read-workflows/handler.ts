import { Injectable } from '@nestjs/common';
import { type WorkflowsRead, WorkflowsReader } from '../../workflows-reader.js';

export { MAX_LISTED_WORKFLOWS } from '../../workflows-reader.js';
export type { WorkflowView, WorkflowItemView } from '../../workflows-reader.js';

export type ReadWorkflowsResult = WorkflowsRead;

/** The Workflow folders of the definitions Repository at its last fetched commit. */
@Injectable()
export class ReadWorkflowsHandler {
  constructor(private readonly reader: WorkflowsReader) {}

  async execute(): Promise<ReadWorkflowsResult> {
    return this.reader.read();
  }
}
