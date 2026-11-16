/** Types of Studio's PreToolUse hook (claude-guard.mjs), for its tests. */
export function decide(
  input: { tool_name?: string; tool_input?: Record<string, unknown>; cwd?: string } | undefined,
  context: { projectDir?: string | undefined; home?: string | undefined },
): string | null;
