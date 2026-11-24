/**
 * Which finished operations change what runs: a succeeded build, stop or data removal, and a
 * failed build that removed the Preview. The store's statement for the newest such operation
 * follows this rule, which a fixture test proves.
 */
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
