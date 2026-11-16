#!/usr/bin/env node
// Studio's PreToolUse hook for Claude Code (Issue #105). GUARDRAIL, NOT THE SECURITY BOUNDARY:
// the boundary is the operating-system user with its rootless Docker daemon (ADR 0002,
// docs/engineering/security.md §2). A misled agent can get around these checks (an interpreter,
// an encoded command, a script it writes); they only stop the obvious mistakes early and say why.
//
// The agent worker copies this file and claude-settings.json (same folder) into the Run's
// directory before every Run step and points the settings' hook at the copy, so nothing from
// the repository is ever executed as a hook. Claude Code passes the tool call as JSON on
// standard input; exit code 2 blocks the call and shows the reason to the agent, exit code 0
// leaves it to the permission rules.
//
// It blocks:
// - privilege escalation (sudo, su, doas, pkexec) and `git push` (the worker delivers, #102);
// - recursive deletes of the filesystem root or the home directory;
// - the system Docker daemon (its socket, `docker -H/--host`, `docker context`, `DOCKER_HOST=`);
// - file writes (Edit, MultiEdit, Write, NotebookEdit) outside the Working copy and the Run
//   step's temporary directory;
// - reading the CLIs' logins and other credentials in the agent user's home directory.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
  /\.claude\/\.credentials|\.codex\/auth|\.git-credentials|\.ssh\/id_|\.config\/gh\/hosts/;
/** Credential locations under the home directory, as paths relative to it. */
const CREDENTIAL_PATHS = [
  '.claude/.credentials.json',
  '.codex',
  '.ssh',
  '.git-credentials',
  '.config/gh',
];
const DOCKER_SOCKETS = ['/var/run/docker.sock', '/run/docker.sock'];
const WRITING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

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

function checkBash(command) {
  if (/docker\.sock/.test(command)) return 'the system Docker daemon is off limits';
  if (/(^|[\s;&|(])DOCKER_HOST=/.test(command)) {
    return 'the Docker daemon is fixed for the Run (no DOCKER_HOST=)';
  }
  if (CREDENTIAL_TEXT.test(command)) return 'logins and credentials are off limits';
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

/** `path` with symbolic links of its existing part resolved (lexical for the rest). */
function real(path) {
  let existing = path;
  const rest = [];
  while (!existsSync(existing) && existing !== posix.dirname(existing)) {
    rest.unshift(posix.basename(existing));
    existing = posix.dirname(existing);
  }
  try {
    return posix.join(realpathSync(existing), ...rest);
  } catch {
    return path;
  }
}

function inside(path, dir) {
  if (!dir) return false;
  const lexical = posix.resolve(dir);
  return [lexical, real(lexical)].some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * Whether Studio's guardrails block a tool call: the reason, or `null` to leave it to the
 * permission rules. `env` gives `CLAUDE_PROJECT_DIR` (the Working copy), `TMPDIR` (the Run
 * step's temporary directory) and `HOME`.
 */
export function decide(input, env) {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input ?? {};
  const project = env.CLAUDE_PROJECT_DIR || input?.cwd;
  const home = env.HOME;
  if (tool === 'Bash') {
    return typeof toolInput.command === 'string' ? checkBash(toolInput.command) : null;
  }
  const target = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
  if (typeof target !== 'string' || target === '') return null;
  const expanded = home && target.startsWith('~/') ? posix.join(home, target.slice(2)) : target;
  // As written and with symbolic links resolved: a link must not lead around a check.
  const lexical = posix.resolve(project ?? '/', expanded);
  const paths = [lexical, real(lexical)];
  if (paths.some((path) => DOCKER_SOCKETS.includes(path))) {
    return 'the system Docker daemon is off limits';
  }
  if (
    home &&
    paths.some((path) => CREDENTIAL_PATHS.some((entry) => inside(path, posix.join(home, entry))))
  ) {
    return 'logins and credentials are off limits';
  }
  if (
    WRITING_TOOLS.has(tool) &&
    !paths.every((path) => inside(path, project) || inside(path, env.TMPDIR))
  ) {
    return 'files are written only inside the Working copy (or the temporary directory)';
  }
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
