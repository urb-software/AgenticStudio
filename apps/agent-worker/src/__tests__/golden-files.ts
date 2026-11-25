import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repository files, and the marker, of the golden outputs of the built-in Default agent. */
export const GOLDEN_REPOSITORY: Record<string, string> = {
  'CLAUDE.md': 'Use pnpm. See @docs/style.md.\n',
  'AGENTS.md': 'Run the tests before you finish.\n',
  'docs/style.md': 'Two-space indentation.\n',
};
export const GOLDEN_MARKER = 'feedc0de';

/**
 * What the instructions file and the Codex prompt were before agent instructions existed, for the
 * files above and the Task "Add a health check": captured once from the earlier builder.
 */
export const golden = (name: 'claude-instructions' | 'codex-prompt'): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', `default-agent-${name}.golden.txt`), 'utf8');
