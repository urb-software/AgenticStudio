/** Which finished operations change what runs, the selection the store's statement follows. */
export class PreviewRunningRule {
  private constructor() {}

  static create(): PreviewRunningRule {
    return new PreviewRunningRule();
  }

  /** A state check changes what runs only when it found the Preview gone (`previewRemoved`). */
  changesRunning(operation: { kind: string; status: string; previewRemoved: boolean }): boolean {
    if (operation.status === 'succeeded') {
      return (
        operation.kind === 'build' ||
        operation.kind === 'stop' ||
        operation.kind === 'remove_data' ||
        (operation.kind === 'state' && operation.previewRemoved)
      );
    }
    return operation.status === 'failed' && operation.kind === 'build' && operation.previewRemoved;
  }
}
