import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { GUARDRAILS_DIR } from '../managed-guardrails.js';

/**
 * Studio's guardrail settings for Claude Code (Issues #105, #134):
 * `guardrails/claude-managed-settings.json` (allowed tools, deny rules, managed-only hooks and
 * permission rules, the PreToolUse hook) and `guardrails/claude-guard.mjs` (the hook), in the
 * agent worker's own folder, never the repository's. GUARDRAILS, NOT THE SECURITY BOUNDARY
 * (ADR 0002, security.md §2).
 *
 * Since #134 the server setup installs both, root-owned, as Claude Code's managed settings
 * (`/etc/claude-code/managed-settings.json`) and the guard script the managed hook runs; the
 * worker checks them before every step (managed-guardrails.ts). Managed settings load whatever
 * `--setting-sources` says, above `--settings`. The per-Run `--settings` file holds nothing
 * (`{}`): the compliance record's command keeps the option. `--allowedTools` still gets the
 * managed allow rules (the record's command too; the CLI ignores it under
 * `allowManagedPermissionRulesOnly`).
 */

export const GUARDRAIL_FILES = {
  settings: 'claude-managed-settings.json',
  hook: 'claude-guard.mjs',
} as const;

const hookSchema = z.object({ type: z.literal('command'), command: z.string().min(1) }).loose();

/** The parts of the managed settings the worker relies on. */
const guardrailSettingsSchema = z
  .object({
    allowManagedHooksOnly: z.literal(true),
    allowManagedPermissionRulesOnly: z.literal(true),
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

export interface PreparedSettings {
  /** The per-Run settings file in the Run's directory (`--settings`): `{}`. */
  settingsFile: string;
  /** The allowed tool rules (`--allowedTools`), exactly the managed settings' `permissions.allow`. */
  allowedTools: string[];
}

/** Reads and checks Studio's managed settings (the worker's copy). Throws when malformed. */
export async function readGuardrailSettings(dir = GUARDRAILS_DIR): Promise<GuardrailSettings> {
  const text = await readFile(join(dir, GUARDRAIL_FILES.settings), 'utf8');
  return guardrailSettingsSchema.parse(JSON.parse(text));
}

/**
 * Writes the per-Run settings file (`{}`, owner-only, replacing anything there) and returns the
 * allowed tool rules from the managed settings.
 */
export async function prepareRunSettings(
  settingsFile: string,
  dir = GUARDRAILS_DIR,
): Promise<PreparedSettings> {
  const settings = await readGuardrailSettings(dir);
  await writeFile(settingsFile, '{}\n', { mode: 0o600 });
  return { settingsFile, allowedTools: [...settings.permissions.allow] };
}
