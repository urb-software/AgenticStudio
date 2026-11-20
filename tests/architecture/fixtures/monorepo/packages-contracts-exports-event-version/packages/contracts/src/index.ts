export const runPayloadSchema = { parse: (value: unknown) => value };

// Forbidden: packages/contracts holds the worker protocol, not an Integration Event.
export const ExecutionCompletedV1Schema = { parse: (value: unknown) => value };
