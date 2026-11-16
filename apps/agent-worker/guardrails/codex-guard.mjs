#!/usr/bin/env node
// Studio's PreToolUse hook for Codex (Issue #106). GUARDRAIL, NOT THE SECURITY BOUNDARY: the
// boundary is the operating-system user with its rootless Docker daemon (ADR 0002,
// docs/engineering/security.md §2). A misled agent can get around these checks (an interpreter,
// an encoded command, a script it writes); they only stop the obvious mistakes early and say why.
//
// The agent worker copies this file into the agent user's Codex home ($HOME/.codex/studio/) and
// writes $HOME/.codex/hooks.json pointing at the copy before every Codex Run step, so nothing
// from the repository is ever executed as a hook (an untrusted project's hooks never load).
// Codex passes the tool call as JSON on standard input (`tool_name` `Bash` with
// `tool_input.command`, or `apply_patch` with the patch in `tool_input.command`); exit code 2
// blocks the call and shows the reason to the agent, exit code 0 lets it go on.
//
// It blocks:
// - privilege escalation (sudo, su, doas, pkexec) and `git push` (the worker delivers, #102);
// - recursive deletes of the filesystem root or the home directory;
// - the system Docker daemon (its socket, `docker -H/--host`, `docker context`, `DOCKER_HOST=`);
// - the CLIs' logins, other credentials and the Codex home (Studio's configuration);
// - patches that write outside the Working copy (the session's working directory).
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRIVILEGED = new Set(['sudo', 'su', 'doas', 'pkexec']);
const ROOT_TARGETS = new Set([
  '/',
  '/*',
  '~',
  '~/',
  '~/*',
  '$HOME',
  '$HOME/',
  '$HOME/*',
  '${HOME}',
  '${HOME}/',
  '${HOME}/*',
]);
const CREDENTIAL_TEXT =
  /\.claude\/\.credentials|\.git-credentials|\.ssh\/id_|\.config\/gh\/hosts|(~|\$HOME|\$\{HOME\})\/\.codex(\/|\b)/;
/** Credential and configuration locations under the home directory, relative to it. */
const PROTECTED_PATHS = [
  '.claude/.credentials.json',
  '.codex',
  '.ssh',
  '.git-credentials',
  '.config/gh',
];

/** The command's simple commands: split at `;`, `&&`, `||`, `|`, `&` and line breaks. */
function segments(command) {
  return command
    .split(/;|&&|\|\||\||&|\n/)
    .map((part) => part.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

/** The program of a simple command, past `env`, variable assignments and a path prefix. */
function program(tokens) {
  let i = 0;
  while (i < tokens.length && (tokens[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])))
    i++;
  return { name: posix.basename(tokens[i] ?? ''), args: tokens.slice(i + 1) };
}

function checkCommand(command, home) {
  if (/docker\.sock/.test(command)) return 'the system Docker daemon is off limits';
  if (/(^|[\s;&|(])DOCKER_HOST=/.test(command)) {
    return 'the Docker daemon is fixed for the Run (no DOCKER_HOST=)';
  }
  if (CREDENTIAL_TEXT.test(command)) return 'logins, credentials and the Codex home are off limits';
  if (home && home !== '/' && command.includes(posix.join(home, '.codex'))) {
    return 'logins, credentials and the Codex home are off limits';
  }
  for (const tokens of segments(command)) {
    const { name, args } = program(tokens);
    if (PRIVILEGED.has(name)) return `${name} is not allowed (no privilege escalation)`;
    if (name === 'git' && args.includes('push')) {
      return 'git push is not allowed: the agent worker pushes the Run branch when the step ends';
    }
    if (name === 'docker' && args.some((arg) => /^(-H|--host)(=|$)/.test(arg))) {
      return 'the Docker daemon is fixed for the Run (no -H/--host)';
    }
    if (name === 'docker' && args[0] === 'context') return 'docker context is not allowed';
    if (name === 'rm') {
      const recursive = args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
      if (recursive && args.some((arg) => ROOT_TARGETS.has(arg))) {
        return 'deleting the root or the home directory is not allowed';
      }
    }
  }
  return null;
}

/** The files a patch adds, updates, deletes or moves to. */
export function patchTargets(patch) {
  const targets = [];
  for (const line of patch.split('\n')) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/.exec(line);
    if (match) targets.push(match[1]);
  }
  return targets;
}

function inside(path, dir) {
  if (!dir) return false;
  const base = posix.resolve(dir);
  return path === base || path.startsWith(`${base}/`);
}

function checkPatch(patch, cwd, home) {
  for (const target of patchTargets(patch)) {
    const expanded = home && target.startsWith('~/') ? posix.join(home, target.slice(2)) : target;
    const path = posix.resolve(cwd ?? '/', expanded);
    if (home && PROTECTED_PATHS.some((entry) => inside(path, posix.join(home, entry)))) {
      return 'logins, credentials and the Codex home are off limits';
    }
    if (!inside(path, cwd)) return 'files are written only inside the Working copy';
  }
  return null;
}

/**
 * Whether Studio's guardrails block a tool call: the reason, or `null` to let it go on. `env`
 * gives `HOME`; the Working copy is the session's working directory (`cwd`).
 */
export function decide(input, env) {
  const tool = input?.tool_name;
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return null;
  if (tool === 'Bash') return checkCommand(command, env.HOME);
  if (tool === 'apply_patch') return checkPatch(command, input?.cwd, env.HOME);
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.stderr.write("Blocked by Studio's guardrails: the tool call could not be read.\n");
    process.exit(2);
  }
  const reason = decide(input, process.env);
  if (reason !== null) {
    process.stderr.write(`Blocked by Studio's guardrails: ${reason}.\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
