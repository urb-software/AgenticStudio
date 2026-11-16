import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Studio's guardrail settings for Claude Code (Issue #105): `guardrails/claude-settings.json`
 * (allowed tools, deny rules, the PreToolUse hook) and `guardrails/claude-guard.mjs` (the hook),
 * in the agent worker's own folder, never the repository's. GUARDRAILS, NOT THE SECURITY
 * BOUNDARY (ADR 0002, security.md §2). Before every Run step both are copied into the Run's
 * directory, the hook command pointing at the copy with the worker's own Node binary; the CLI
 * gets the copy with `--settings` and the allowed tools with `--allowedTools`.
 */

/** The worker's guardrails folder: `apps/agent-worker/guardrails` (from `src/` and `dist/`). */
export const GUARDRAILS_DIR = fileURLToPath(new URL('../../guardrails/', import.meta.url));

export const GUARDRAIL_FILES = {
  settings: 'claude-settings.json',
  hook: 'claude-guard.mjs',
} as const;

const hookSchema = z.object({ type: z.literal('command'), command: z.string().min(1) }).loose();

/** The parts of the settings file the worker relies on; the rest is passed through as is. */
const guardrailSettingsSchema = z
  .object({
    permissions: z
      .object({
        allow: z.array(z.string().min(1)).min(1),
        deny: z.array(z.string().min(1)).min(1),
      })
      .loose(),
    hooks: z
      .object({
        PreToolUse: z
          .array(z.object({ matcher: z.string(), hooks: z.array(hookSchema).min(1) }).loose())
          .min(1),
      })
      .loose(),
  })
  .loose();

type GuardrailSettings = z.infer<typeof guardrailSettingsSchema>;

/** A POSIX shell word: single-quoted, so the CLI's shell never expands it. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface PreparedGuardrails {
  /** The settings copy in the Run's directory (`--settings`). */
  settingsFile: string;
  /** The allowed tool rules (`--allowedTools`), exactly the settings file's `permissions.allow`. */
  allowedTools: string[];
}

export interface GuardrailsOptions {
  /** Where Studio's files are (default {@link GUARDRAILS_DIR}). */
  dir?: string;
  /** The Node binary that runs the hook (default: the worker's own). */
  nodePath?: string;
}

/** Reads and checks Studio's settings file. Throws when it is missing or malformed. */
export async function readGuardrailSettings(dir = GUARDRAILS_DIR): Promise<GuardrailSettings> {
  const text = await readFile(join(dir, GUARDRAIL_FILES.settings), 'utf8');
  return guardrailSettingsSchema.parse(JSON.parse(text));
}

/**
 * Copies Studio's guardrails into the Run's directory as `settingsFile` and `guardScript`, with
 * every hook command replaced by `<node> <guardScript>`. Owner-only files.
 */
export async function prepareGuardrails(
  target: { settingsFile: string; guardScript: string },
  options: GuardrailsOptions = {},
): Promise<PreparedGuardrails> {
  const dir = options.dir ?? GUARDRAILS_DIR;
  const settings = await readGuardrailSettings(dir);
  const command = `${shellWord(options.nodePath ?? process.execPath)} ${shellWord(target.guardScript)}`;
  const copy: GuardrailSettings = {
    ...settings,
    hooks: {
      ...settings.hooks,
      PreToolUse: settings.hooks.PreToolUse.map((entry) => ({
        ...entry,
        hooks: entry.hooks.map((hook) => ({ ...hook, command })),
      })),
    },
  };
  await copyFile(join(dir, GUARDRAIL_FILES.hook), target.guardScript);
  await writeFile(target.settingsFile, `${JSON.stringify(copy, null, 2)}\n`, { mode: 0o600 });
  return { settingsFile: target.settingsFile, allowedTools: [...settings.permissions.allow] };
}
