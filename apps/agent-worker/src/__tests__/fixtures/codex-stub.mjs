#!/usr/bin/env node
// A stand-in for the Codex CLI that replays codex-recordings/<name>.jsonl, picked by the
// `[stub:<name>]` token on standard input, and appends how it was started to
// `../codex-stub-calls.ndjson` beside the Working copy.
import { appendFileSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.169.0\n');
  process.exit(0);
}

const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const resumeAt = args.indexOf('resume');
const resumed = resumeAt === -1 ? undefined : args[resumeAt + 1];

const stdinStat = fstatSync(0);
const isPipe = stdinStat.isFIFO() || stdinStat.isSocket();
const stdinText = isPipe ? '' : readFileSync(0, 'utf8');
const scenario = /\[stub:([a-z-]+)\]/.exec(stdinText)?.[1] ?? (resumed ? 'resume' : 'success');
let config = null;
try {
  config = readFileSync(join(process.env.HOME ?? '/nonexistent', '.codex', 'config.toml'), 'utf8');
} catch {
  // No Codex home.
}
appendFileSync(
  resolve(process.cwd(), '..', 'codex-stub-calls.ndjson'),
  `${JSON.stringify({
    argv: args,
    env: process.env,
    cwd: process.cwd(),
    stdin: isPipe ? 'pipe' : 'file',
    stdinText,
    config,
    scenario,
  })}\n`,
);

const RECORDED_THREAD = '0199a8f2-6c1e-7d43-9b2a-5e8f1c3d7a90';
const EXIT_CODES = { 'turn-failed': 1, 'usage-limit': 1, 'no-result': 2 };
const here = dirname(fileURLToPath(import.meta.url));
const replay = (name) =>
  readFileSync(join(here, 'codex-recordings', `${name}.jsonl`), 'utf8').replaceAll(
    RECORDED_THREAD,
    resumed ?? RECORDED_THREAD,
  );

if (scenario === 'slow') {
  process.stdout.write(replay('success').split('\n')[0] + '\n');
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => undefined, 1000);
} else if (scenario === 'no-result') {
  process.stderr.write('Error: something went wrong before the first event\n');
  process.exit(EXIT_CODES['no-result']);
} else {
  const stream = replay(scenario);
  const lastMessage = stream
    .split('\n')
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event.item?.type === 'agent_message' ? [event.item.text] : [];
      } catch {
        return [];
      }
    })
    .at(-1);
  const resultFile = value('--output-last-message');
  if (resultFile && lastMessage !== undefined) writeFileSync(resultFile, lastMessage);
  process.stdout.write(stream, () => process.exit(EXIT_CODES[scenario] ?? 0));
}
