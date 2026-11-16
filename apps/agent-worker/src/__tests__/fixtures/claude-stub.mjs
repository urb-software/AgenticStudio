#!/usr/bin/env node
// A stand-in for the Claude Code CLI in regular tests (Issue #105): no network, no login, no
// model. It replays a recorded stream-json event stream (claude-recordings/<name>.ndjson,
// shaped like CLI 2.1.325's) and records how it was started, so tests can assert the exact
// arguments, the environment, the working directory and standard input at the spawn boundary.
//
// - `--version` prints a supported version.
// - The scenario is the `[stub:<name>]` token in the prompt (the argument after `-p`); a
//   resumed step (`--resume <id>`) defaults to `resume` and reports the session it resumed.
// - `slow` prints the init event and waits (for stop tests); it exits on SIGINT like the CLI.
// - Each call is appended as one JSON line to `../claude-stub-calls.ndjson` (beside the
//   Working copy, in the Run's directory).
import { appendFileSync, fstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('2.1.325 (Claude Code)\n');
  process.exit(0);
}

const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const prompt = value('-p') ?? '';
const resumed = value('--resume');
const scenario = /\[stub:([a-z-]+)\]/.exec(prompt)?.[1] ?? (resumed ? 'resume' : 'success');

const stdinStat = fstatSync(0);
const stdin = stdinStat.isFIFO() || stdinStat.isSocket()
  ? 'pipe'
  : `closed (${readFileSync(0).length} bytes)`;
appendFileSync(
  resolve(process.cwd(), '..', 'claude-stub-calls.ndjson'),
  `${JSON.stringify({ argv: args, env: process.env, cwd: process.cwd(), stdin, scenario })}\n`,
);

const RECORDED_SESSION = '8f14e45f-ceea-4c8b-9f2e-1f5a7b3c9d20';
const EXIT_CODES = { error: 1, 'usage-limit': 1, 'no-result': 2 };
const here = dirname(fileURLToPath(import.meta.url));
const recordings = join(here, 'claude-recordings');
const replay = (name) =>
  readFileSync(join(recordings, `${name}.ndjson`), 'utf8')
    .replaceAll(RECORDED_SESSION, resumed ?? RECORDED_SESSION);

if (scenario === 'slow') {
  process.stdout.write(replay('success').split('\n')[0] + '\n');
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => undefined, 1000);
} else if (scenario === 'no-result') {
  process.stderr.write('Error: something went wrong before the first event\n');
  process.exit(EXIT_CODES['no-result']);
} else {
  process.stdout.write(replay(scenario), () => process.exit(EXIT_CODES[scenario] ?? 0));
}
