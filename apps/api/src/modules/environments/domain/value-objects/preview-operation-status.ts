/** `requested` waits for a controller, `claimed` is held by one, the other two are final. */
export const PREVIEW_OPERATION_STATUSES = ['requested', 'claimed', 'succeeded', 'failed'] as const;
export type PreviewOperationStatus = (typeof PREVIEW_OPERATION_STATUSES)[number];
