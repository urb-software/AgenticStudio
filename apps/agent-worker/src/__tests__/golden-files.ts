import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Repository files, and the marker, of the golden outputs of the built-in Default agent. */
export const GOLDEN_REPOSITORY: Record<string, string> = {
  'CLAUDE.md': 'Use pnpm. See @docs/style.md.\n',
  'AGENTS.md': 'Run the tests before you finish.\n',
  'docs/style.md': 'Two-space indentation.\n',
};
/** Repository text well over 64 KiB, with multi-byte characters, so the earlier cut applies. */
export const GOLDEN_BIG_REPOSITORY: Record<string, string> = {
  'CLAUDE.md': 'Use pnpm. éè '.repeat(5_000) + 'x'.repeat(50_000) + '\n',
  'AGENTS.md': 'Run the tests. éè '.repeat(6_000) + 'y'.repeat(30_000) + '\n',
};
export const GOLDEN_MARKER = 'feedc0de';

/**
 * What the instructions file and the Codex prompt were before agent instructions existed, for the
 * files above and the Task "Add a health check": captured once from the earlier builder.
 */
export const golden = (
  name: 'claude-instructions' | 'codex-prompt' | 'claude-instructions-big' | 'codex-prompt-big',
): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', `default-agent-${name}.golden.txt`), 'utf8');

/** The notices the earlier builder gave for the big repository text. */
export const goldenNotices = (runner: 'claude' | 'codex'): string[] =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, 'fixtures', `default-agent-${runner}-notices-big.golden.json`),
      'utf8',
    ),
  ) as string[];
