/** Which finished operations change what runs, the selection the store's statement follows. */
export class PreviewRunningRule {
  private constructor() {}

  static create(): PreviewRunningRule {
    return new PreviewRunningRule();
  }

  changesRunning(operation: { kind: string; status: string; previewRemoved: boolean }): boolean {
    if (operation.status === 'succeeded') {
      return (
        operation.kind === 'build' || operation.kind === 'stop' || operation.kind === 'remove_data'
      );
    }
    return operation.status === 'failed' && operation.kind === 'build' && operation.previewRemoved;
  }
}
