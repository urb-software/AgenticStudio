export type RecordExecutionInput = { projectId: string; executionId: string };

export class RecordExecutionHandler {
  readonly recorded: string[] = [];

  async execute(input: RecordExecutionInput): Promise<void> {
    this.recorded.push(input.projectId + ':' + input.executionId);
  }
}
