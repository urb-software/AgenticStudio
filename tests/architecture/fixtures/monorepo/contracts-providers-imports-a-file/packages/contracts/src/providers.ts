import { z } from './zod-like.js';

export const PROVIDERS = z(['claude_code', 'codex'] as const);
