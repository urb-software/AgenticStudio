export class RecordExecutionHandler {
  readonly recorded: string[] = [];

  async execute(projectId: string, executionId: string): Promise<void> {
    this.recorded.push(projectId + ':' + executionId);
  }
}
