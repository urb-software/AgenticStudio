import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { GUARDRAILS_DIR, HOOK_INTERPRETER, readManagedFiles } from '../../managed-guardrails.js';

/**
 * Installs Studio's managed guardrail files under `root` the way the server setup does (files
 * 0644, directories 0755), plus a stand-in for the hooks' interpreter (0755), all owned by the
 * test's own user (Issue #134). Returns `root`.
 */
export async function installManagedGuardrails(root: string): Promise<string> {
  // Every directory from `root` down, 0755 whatever the umask (the worker checks them all).
  const directory = async (dir: string) => {
    await mkdir(dir, { recursive: true });
    for (let current = dir; current !== root; current = posix.dirname(current)) {
      await chmod(current, 0o755);
    }
  };
  for (const file of await readManagedFiles()) {
    const target = join(root, file.path);
    await directory(posix.dirname(target));
    await copyFile(join(GUARDRAILS_DIR, file.source), target);
    await chmod(target, 0o644);
  }
  const node = join(root, HOOK_INTERPRETER);
  await directory(posix.dirname(node));
  await writeFile(node, '#!/bin/sh\n');
  await chmod(node, 0o755);
  await chmod(root, 0o755);
  return root;
}
