/** What the environment controller can be asked to do; the controller protocol's list is pinned to it by a test. */
export const PREVIEW_OPERATION_KINDS = ['build', 'stop', 'remove_data', 'state'] as const;
export type PreviewOperationKind = (typeof PREVIEW_OPERATION_KINDS)[number];
