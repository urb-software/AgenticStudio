import { runPayloadSchema } from '@agentic-studio/contracts';

export const parse = (value: unknown) => runPayloadSchema.parse(value);
