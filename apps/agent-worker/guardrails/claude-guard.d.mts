/** Types of Studio's PreToolUse hook (claude-guard.mjs), for its tests. */
export function decide(
  input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string } | undefined,
  env: Record<string, string | undefined>,
): string | null;
